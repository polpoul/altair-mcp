#!/usr/bin/env node
/**
 * Serveur MCP générique pour piloter une instance Altair (axio, nexo, oria...).
 *
 * Ne réinvente rien : s'appuie exactement sur l'API HTTP déjà exposée par
 * l'instance elle-même (voir altair-ux-maquette/deploy-vivalink/PROCEDURE.md) :
 *   - GET  /assets/schema.json  et  /assets/data.json   (lecture, servis par nginx)
 *   - POST /api/save                                    (écriture, save-server — réécrit
 *                                                         TOUT le fichier, pas un record isolé)
 *   - POST /records/notify                               (back — déclenche le moteur de
 *                                                         règles sur un record déjà écrit)
 *   - POST /records/action                               (back — déclenche une action métier)
 *
 * Instances protégées (axio) : ALTAIR_TOKEN (device_token d'un utilisateur de l'auth-service,
 * super-utilisateur pour tout voir) est envoyé en Bearer ; la lecture passe alors par
 * GET /api/data (filtré par droits) et l'écriture par POST /api/patch (champs modifiés
 * seulement). Sans ALTAIR_TOKEN, comportement historique pour les instances sans connexion.
 *
 * Un seul métier par instance de ce serveur : la variable d'environnement ALTAIR_BASE_URL
 * fixe l'URL cible (ex. https://axio.vivalink.top). Pour piloter plusieurs métiers,
 * enregistrer plusieurs instances de ce serveur MCP avec des noms/URLs différents.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const BASE_URL = process.env.ALTAIR_BASE_URL;
if (!BASE_URL) {
  console.error('ALTAIR_BASE_URL manquant (ex. https://axio.vivalink.top)');
  process.exit(1);
}
const LABEL = process.env.ALTAIR_LABEL || new URL(BASE_URL).hostname;
const TOKEN = process.env.ALTAIR_TOKEN;

function authHeaders() {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

// Publication Mercure directe (optionnelle) : /records/notify passe par RabbitMQ + un
// worker asynchrone, ce qui peut être lent/silencieux si le worker est down, ou ne rien
// faire du tout pour un enregistrement tout neuf que le front n'a jamais vu. Publier
// nous-mêmes en HTTP direct sur le hub Mercure (même topic/format que back/src/MessageHandler/
// DomainEventHandler.php) donne un rafraîchissement instantané, indépendant du worker.
// Sans secret configuré, cette fonctionnalité est simplement ignorée (pas d'erreur bloquante).
const MERCURE_JWT_SECRET = process.env.ALTAIR_MERCURE_JWT_SECRET;
const MERCURE_PUBLIC_URL = process.env.ALTAIR_MERCURE_URL || new URL('/.well-known/mercure', BASE_URL).toString();

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signMercureJwt(secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ mercure: { publish: ['*'] } }));
  const signature = base64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

async function publishMercure(typeId, id, extra = {}) {
  if (!MERCURE_JWT_SECRET) return;
  const jwt = signMercureJwt(MERCURE_JWT_SECRET);
  const body = new URLSearchParams();
  body.append('topic', `${typeId}/${id}`);
  body.append(
    'data',
    JSON.stringify({ entityType: typeId, entityId: id, appliedRules: [], processedAt: new Date().toISOString(), ...extra }),
  );
  const res = await fetch(MERCURE_PUBLIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${jwt}` },
    body,
  });
  if (!res.ok) throw new Error(`Mercure publish -> ${res.status} ${await res.text()}`);
}

async function getJson(path) {
  const res = await fetch(new URL(path, BASE_URL), { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(new URL(path, BASE_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: `Erreur : ${message}` }], isError: true };
}

// Instance protégée : le schéma vit dans le volume de données (source unique, modifiable par update_schema) ;
// sinon fichier statique comme avant.
async function loadSchema() {
  return getJson(TOKEN ? '/api/files/schema.json' : '/assets/schema.json');
}

async function loadData() {
  return getJson(TOKEN ? '/api/data' : '/assets/data.json');
}

// Instance protégée : seul le patch part (le serveur refuse l'écriture du fichier entier).
async function persistData(data, patch) {
  return TOKEN ? postJson('/api/patch', patch) : postJson('/api/save', { file: 'data.json', content: data });
}

async function notifyAndPublish(typeId, id, changedFields, extra = {}) {
  const warnings = [];
  try {
    await postJson('/records/notify', { typeId, id, changedFields });
  } catch (e) {
    warnings.push(`moteur de règles non notifié : ${e.message}`);
  }
  try {
    await publishMercure(typeId, id, extra);
  } catch (e) {
    warnings.push(`publication Mercure échouée : ${e.message}`);
  }
  return warnings;
}

function findType(schema, typeId) {
  return schema.types.find((t) => t.id === typeId);
}

function flatFieldKeys(type) {
  // Exclut les champs à chemin (ex. "projetId.nom") : toujours en lecture seule,
  // résolus depuis un autre type — jamais des clés stockées sur CE type.
  return type.fields.filter((f) => !f.key.includes('.')).map((f) => f.key);
}

const server = new McpServer({ name: `altair-mcp (${LABEL})`, version: '1.0.0' });

server.registerTool(
  'list_types',
  {
    title: 'Lister les types d’objets',
    description: `Liste les types d'objets (ObjectType) déclarés dans le schéma de ${LABEL}, avec leurs champs et leurs relations. À appeler en premier pour savoir quels typeId/champs existent avant de lire ou écrire des enregistrements.`,
    inputSchema: {},
  },
  async () => {
    const schema = await loadSchema();
    const types = schema.types.map((t) => ({
      id: t.id,
      label: t.label,
      fields: t.fields.map((f) => ({ key: f.key, label: f.label, type: f.type || 'text', readOnly: f.key.includes('.'), options: f.options })),
      titleFields: t.titleFields || [],
    }));
    return textResult({ types, relations: schema.relations });
  },
);

server.registerTool(
  'list_records',
  {
    title: 'Lister des enregistrements',
    description: `Liste les enregistrements d'un type donné sur ${LABEL}, avec un filtre optionnel d'égalité exacte sur un champ (ex. { statut: "En cours" }).`,
    inputSchema: {
      typeId: z.string().describe('Id du type (voir list_types), ex. "tache"'),
      filters: z.record(z.string()).optional().describe('Filtre optionnel { champ: valeur } — égalité exacte sur des champs stockés directement (pas des chemins)'),
    },
  },
  async ({ typeId, filters }) => {
    const data = await loadData();
    let records = data[typeId] || [];
    if (filters) {
      records = records.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
    }
    return textResult(records);
  },
);

server.registerTool(
  'get_record',
  {
    title: 'Lire un enregistrement',
    description: `Retourne un enregistrement précis (par typeId + id) sur ${LABEL}.`,
    inputSchema: {
      typeId: z.string(),
      id: z.string(),
    },
  },
  async ({ typeId, id }) => {
    const data = await loadData();
    const record = (data[typeId] || []).find((r) => r.id === id);
    if (!record) return errorResult(`Aucun enregistrement ${typeId}/${id}`);
    return textResult(record);
  },
);

server.registerTool(
  'create_record',
  {
    title: 'Créer un enregistrement',
    description: `Crée un nouvel enregistrement d'un type donné sur ${LABEL}. Les champs non fournis sont initialisés à chaîne vide. Déclenche ensuite le moteur de règles (recalculs dépendants, ex. avancement d'un projet après ajout d'une tâche).`,
    inputSchema: {
      typeId: z.string(),
      fields: z.record(z.string()).describe('Champs à valeur, en string (nombres/dates/checkbox stockés en texte, voir list_types)'),
    },
  },
  async ({ typeId, fields }) => {
    const schema = await loadSchema();
    const type = findType(schema, typeId);
    if (!type) return errorResult(`Type inconnu : ${typeId}`);
    const pathKeys = Object.keys(fields).filter((k) => k.includes('.'));
    if (pathKeys.length) return errorResult(`Champs en lecture seule (chemin), à ne pas fournir : ${pathKeys.join(', ')}`);
    const fileKeys = type.fields.filter((f) => f.type === 'file').map((f) => f.key);
    const written = Object.keys(fields).filter((k) => fileKeys.includes(k));
    if (written.length) return errorResult(`Champs de type file : utiliser attach_file / remove_file (${written.join(', ')})`);

    const data = await loadData();
    const records = data[typeId] || [];
    const id = `${typeId}-${Date.now()}`;
    const flatKeys = flatFieldKeys(type);
    const record = { id };
    for (const key of flatKeys) record[key] = fields[key] ?? '';
    for (const key of Object.keys(fields)) {
      if (!flatKeys.includes(key)) return errorResult(`Champ inconnu sur ${typeId} : ${key}`);
    }
    records.push(record);
    data[typeId] = records;
    const { id: _id, ...newFields } = record;
    await persistData(data, { upserts: [{ typeId, id, fields: newFields }] });
    const warnings = await notifyAndPublish(typeId, id, Object.keys(fields));
    return textResult(warnings.length ? { record, warnings } : record);
  },
);

server.registerTool(
  'update_record',
  {
    title: 'Modifier un enregistrement',
    description: `Modifie un ou plusieurs champs d'un enregistrement existant sur ${LABEL}. Déclenche ensuite le moteur de règles sur les champs changés (ex. recalcul de avancement si le statut d'une tâche change).`,
    inputSchema: {
      typeId: z.string(),
      id: z.string(),
      fields: z.record(z.string()),
    },
  },
  async ({ typeId, id, fields }) => {
    const schema = await loadSchema();
    const type = findType(schema, typeId);
    if (!type) return errorResult(`Type inconnu : ${typeId}`);
    const pathKeys = Object.keys(fields).filter((k) => k.includes('.'));
    if (pathKeys.length) return errorResult(`Champs en lecture seule (chemin), à ne pas fournir : ${pathKeys.join(', ')}`);
    const flatKeys = flatFieldKeys(type);
    for (const key of Object.keys(fields)) {
      if (!flatKeys.includes(key)) return errorResult(`Champ inconnu sur ${typeId} : ${key}`);
    }
    const fileKeys = type.fields.filter((f) => f.type === 'file').map((f) => f.key);
    const written = Object.keys(fields).filter((k) => fileKeys.includes(k));
    if (written.length) return errorResult(`Champs de type file : utiliser attach_file / remove_file (${written.join(', ')})`);

    const data = await loadData();
    const records = data[typeId] || [];
    const record = records.find((r) => r.id === id);
    if (!record) return errorResult(`Aucun enregistrement ${typeId}/${id}`);
    Object.assign(record, fields);
    await persistData(data, { upserts: [{ typeId, id, fields }] });
    const warnings = await notifyAndPublish(typeId, id, Object.keys(fields));
    return textResult(warnings.length ? { record, warnings } : record);
  },
);

server.registerTool(
  'delete_record',
  {
    title: 'Supprimer un enregistrement',
    description: `Supprime un enregistrement sur ${LABEL}. Limitation connue du back (voir back/README.md) : aucun événement de suppression n'existe, donc rien ne recalcule automatiquement les compteurs/relations qui en dépendaient (ex. avancement d'un projet après suppression d'une de ses tâches) — à recalculer manuellement si besoin via update_record.`,
    inputSchema: {
      typeId: z.string(),
      id: z.string(),
    },
  },
  async ({ typeId, id }) => {
    const data = await loadData();
    const records = data[typeId] || [];
    const index = records.findIndex((r) => r.id === id);
    if (index === -1) return errorResult(`Aucun enregistrement ${typeId}/${id}`);
    const [removed] = records.splice(index, 1);
    data[typeId] = records;
    await persistData(data, { deletes: [{ typeId, id }] });
    // Pas de /records/notify ici : le back ne sait pas traiter un événement de
    // suppression (voir back/README.md, dette connue). La publication Mercure directe,
    // elle, fonctionne quand même pour que le front retire la fiche de l'affichage.
    let warning;
    try {
      await publishMercure(typeId, id, { deleted: true });
    } catch (e) {
      warning = `Supprimé, mais la publication Mercure a échoué : ${e.message}`;
    }
    return textResult(warning ? { deleted: removed, warning } : { deleted: removed });
  },
);

server.registerTool(
  'trigger_action',
  {
    title: 'Déclencher une action métier',
    description: `Déclenche une action déclarée dans le schéma (ObjectType.actions) sur un enregistrement de ${LABEL}, ex. une action qui génère des enregistrements liés.`,
    inputSchema: {
      typeId: z.string(),
      id: z.string(),
      actionId: z.string(),
      params: z.record(z.string()).optional(),
    },
  },
  async ({ typeId, id, actionId, params }) => {
    const result = await postJson('/records/action', { typeId, id, actionId, params: params || {} });
    return textResult(result);
  },
);

// Partage : uniquement sur une instance protégée (jeton). L'inscription d'un utilisateur reste
// une opération d'administrateur (server/add-user.js), volontairement hors de ce serveur.
if (TOKEN) {
  async function findUserId(user) {
    const wanted = user.trim().toLowerCase();
    const users = await getJson('/api/users');
    return users.find((u) => u.id === user.trim() || (u.email ?? '').toLowerCase() === wanted)?.id ?? null;
  }

  server.registerTool(
    'list_users',
    {
      title: 'Lister les utilisateurs',
      description: `Liste les utilisateurs inscrits sur ${LABEL} avec qui partager (id, nom, email), sans l'utilisateur du jeton. À appeler pour retrouver l'id ou l'email à passer à share_record / unshare_record.`,
      inputSchema: {},
    },
    async () => textResult(await getJson('/api/users')),
  );

  server.registerTool(
    'list_owners',
    {
      title: 'Voir qui a accès à un enregistrement',
      description: `Liste les utilisateurs qui ont accès à un enregistrement de ${LABEL} : propriétaires directs, et accès hérités d'un objet parent (ex. le projet d'une tâche, marqué inherited: true).`,
      inputSchema: { id: z.string().describe("Id de l'enregistrement") },
    },
    async ({ id }) => {
      const result = await postJson('/api/owners', { id });
      return textResult(result.owners);
    },
  );

  server.registerTool(
    'share_record',
    {
      title: 'Partager des enregistrements',
      description: `Donne accès à des enregistrements de ${LABEL} à un autre utilisateur (un seul niveau de droit : il pourra les modifier, les partager et les supprimer). Partager un projet partage aussi ses tâches, notes et interactions. L'utilisateur est désigné par son id ou son email (voir list_users) et doit déjà être inscrit.`,
      inputSchema: {
        ids: z.array(z.string()).min(1).describe('Ids des enregistrements à partager'),
        user: z.string().describe("Id ou email du destinataire"),
      },
    },
    async ({ ids, user }) => {
      const userId = await findUserId(user);
      if (!userId) return errorResult(`Utilisateur inconnu : ${user} (voir list_users)`);
      return textResult(await postJson('/api/share', { ids, userId }));
    },
  );

  server.registerTool(
    'unshare_record',
    {
      title: "Retirer l'accès à des enregistrements",
      description: `Retire un utilisateur des propriétaires directs d'enregistrements de ${LABEL}. Refusé si un enregistrement se retrouverait sans aucun propriétaire. stillAccess liste les enregistrements que l'utilisateur voit encore (accès hérité d'un projet : à retirer sur le projet lui-même). L'utilisateur est désigné par son id ou son email.`,
      inputSchema: {
        ids: z.array(z.string()).min(1).describe('Ids des enregistrements'),
        user: z.string().describe("Id ou email de l'utilisateur à retirer"),
      },
    },
    async ({ ids, user }) => {
      const userId = (await findUserId(user)) ?? user.trim();
      return textResult(await postJson('/api/unshare', { ids, userId }));
    },
  );
}

// Documents joints : uniquement sur une instance protégée (le serveur ne les expose qu'avec un jeton).
// Les droits sont ceux de l'objet porteur ; le serveur reste seul juge du type de fichier (extension +
// signature) et de la taille (10 Mo).
if (TOKEN) {
  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  async function fileField(typeId, field) {
    const type = findType(await loadSchema(), typeId);
    if (!type) return { error: `Type inconnu : ${typeId}` };
    const def = type.fields.find((f) => f.key === field);
    if (!def) return { error: `Champ inconnu sur ${typeId} : ${field}` };
    if (def.type !== 'file') return { error: `${typeId}.${field} n'est pas un champ de type file (voir list_types)` };
    return { def };
  }

  async function readMeta(typeId, id, field) {
    const record = ((await loadData())[typeId] || []).find((r) => r.id === id);
    if (!record) return { error: `Aucun enregistrement ${typeId}/${id}` };
    try {
      const meta = JSON.parse(record[field] || 'null');
      return meta && meta.id ? { meta } : { error: `Aucun fichier joint dans ${typeId}/${id}.${field}` };
    } catch {
      return { error: `Aucun fichier joint dans ${typeId}/${id}.${field}` };
    }
  }

  async function failure(res) {
    const text = await res.text();
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      // Texte brut : on le garde tel quel.
    }
    return `${res.status} ${message}`;
  }

  const target = (typeId, id, field) => new URLSearchParams({ typeId, id, field });

  server.registerTool(
    'get_file_info',
    {
      title: "Lire le document joint d'un champ",
      description: `Retourne les métadonnées (nom, type, taille, date, auteur) du document joint d'un champ de type file d'un enregistrement de ${LABEL}. Le champ vaut null s'il n'y a pas de fichier.`,
      inputSchema: { typeId: z.string(), id: z.string(), field: z.string().describe('Clé du champ de type file (voir list_types)') },
    },
    async ({ typeId, id, field }) => {
      const check = await fileField(typeId, field);
      if (check.error) return errorResult(check.error);
      const record = ((await loadData())[typeId] || []).find((r) => r.id === id);
      if (!record) return errorResult(`Aucun enregistrement ${typeId}/${id}`);
      const found = await readMeta(typeId, id, field);
      return textResult({ typeId, id, field, fichier: found.meta ?? null });
    },
  );

  server.registerTool(
    'attach_file',
    {
      title: 'Joindre un document',
      description: `Envoie un fichier local vers le champ de type file d'un enregistrement de ${LABEL} (un seul fichier par champ : il remplace l'éventuel précédent). 10 Mo maximum ; types acceptés : pdf, png, jpg, jpeg, gif, webp, xls, xlsx, doc, docx, zip, csv, txt.`,
      inputSchema: {
        typeId: z.string(),
        id: z.string(),
        field: z.string().describe('Clé du champ de type file (voir list_types)'),
        path: z.string().describe('Chemin du fichier sur cette machine'),
      },
    },
    async ({ typeId, id, field, path }) => {
      const check = await fileField(typeId, field);
      if (check.error) return errorResult(check.error);
      let info;
      try {
        info = await stat(path);
      } catch {
        return errorResult(`Fichier introuvable : ${path}`);
      }
      if (!info.isFile()) return errorResult(`${path} n'est pas un fichier`);
      if (info.size === 0) return errorResult('Fichier vide');
      if (info.size > MAX_FILE_BYTES) return errorResult('Fichier trop volumineux (10 Mo maximum)');

      const query = target(typeId, id, field);
      query.set('name', basename(path));
      const res = await fetch(new URL(`/api/attachments?${query}`, BASE_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...authHeaders() },
        body: await readFile(path),
      });
      if (!res.ok) return errorResult(await failure(res));
      const { fichier } = await res.json();
      // Le serveur a déjà écrit le champ ; on prévient seulement les fiches ouvertes.
      const warnings = [];
      try {
        await publishMercure(typeId, id, { changedFields: [field] });
      } catch (e) {
        warnings.push(`publication Mercure échouée : ${e.message}`);
      }
      return textResult(warnings.length ? { fichier, warnings } : { fichier });
    },
  );

  server.registerTool(
    'download_file',
    {
      title: 'Télécharger un document joint',
      description: `Enregistre sur cette machine le document joint d'un champ de type file d'un enregistrement de ${LABEL}. Retourne le chemin du fichier créé (jamais écrasé : un suffixe est ajouté si le nom existe).`,
      inputSchema: {
        typeId: z.string(),
        id: z.string(),
        field: z.string(),
        directory: z.string().optional().describe('Dossier de destination (par défaut : dossier temporaire du système)'),
      },
    },
    async ({ typeId, id, field, directory }) => {
      const check = await fileField(typeId, field);
      if (check.error) return errorResult(check.error);
      const found = await readMeta(typeId, id, field);
      if (found.error) return errorResult(found.error);

      const res = await fetch(new URL(`/api/attachments/${found.meta.id}`, BASE_URL), { headers: authHeaders() });
      if (!res.ok) return errorResult(await failure(res));
      const folder = directory || join(tmpdir(), 'altair-mcp');
      await mkdir(folder, { recursive: true });

      const name = basename(found.meta.nom);
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      const bytes = Buffer.from(await res.arrayBuffer());
      for (let n = 0; n < 1000; n += 1) {
        const destination = join(folder, n === 0 ? name : `${stem} (${n})${ext}`);
        try {
          await writeFile(destination, bytes, { flag: 'wx' });
          return textResult({ path: destination, fichier: found.meta });
        } catch (e) {
          if (e.code !== 'EEXIST') return errorResult(`Écriture impossible : ${e.message}`);
        }
      }
      return errorResult('Trop de fichiers du même nom dans le dossier de destination');
    },
  );

  server.registerTool(
    'remove_file',
    {
      title: 'Retirer un document joint',
      description: `Supprime le document joint d'un champ de type file d'un enregistrement de ${LABEL} (le contenu est supprimé du serveur et le champ vidé).`,
      inputSchema: { typeId: z.string(), id: z.string(), field: z.string() },
    },
    async ({ typeId, id, field }) => {
      const check = await fileField(typeId, field);
      if (check.error) return errorResult(check.error);
      const res = await fetch(new URL(`/api/attachments?${target(typeId, id, field)}`, BASE_URL), { method: 'DELETE', headers: authHeaders() });
      if (!res.ok) return errorResult(await failure(res));
      const warnings = [];
      try {
        await publishMercure(typeId, id, { changedFields: [field] });
      } catch (e) {
        warnings.push(`publication Mercure échouée : ${e.message}`);
      }
      return textResult(warnings.length ? { ok: true, warnings } : { ok: true });
    },
  );
}

// Schéma : lu par l'API (source unique dans le volume de données) et modifié par opérations structurées,
// validées par le serveur (super-utilisateurs seulement, sauvegarde avant chaque écriture). Le front prend le
// nouveau schéma au rechargement de la page ; le back PHP le relit tout seul.
if (TOKEN) {
  const fieldSpec = z
    .object({
      key: z.string().describe('Clé du champ : lettres, chiffres et _, commence par une lettre (non modifiable ensuite)'),
      label: z.string(),
      type: z.enum(['text', 'textarea', 'checkbox', 'date', 'datetime', 'time', 'number', 'picklist', 'file']).optional().describe('Absent = texte'),
      options: z.array(z.string()).optional().describe('Valeurs d\'un champ picklist (obligatoire pour picklist)'),
      optionColors: z.record(z.string()).optional(),
      category: z.string().describe('Id d\'une catégorie existante du type'),
      order: z.number().optional().describe('Ordre dans la catégorie (par défaut : à la fin)'),
      displayMode: z.enum(['aucun', 'tous', 'complet', 'resume']).optional().describe('Par défaut : complet'),
    })
    .strict();

  const fieldPatch = z
    .object({
      label: z.string().optional(),
      type: z.enum(['text', 'textarea', 'checkbox', 'date', 'datetime', 'time', 'number', 'picklist', 'file']).nullable().optional().describe('null = retirer (texte)'),
      options: z.array(z.string()).nullable().optional(),
      optionColors: z.record(z.string()).nullable().optional(),
      category: z.string().optional(),
      order: z.number().optional(),
      displayMode: z.enum(['aucun', 'tous', 'complet', 'resume']).optional(),
    })
    .strict();

  const change = z.discriminatedUnion('op', [
    z.object({ op: z.literal('addField'), typeId: z.string(), field: fieldSpec }),
    z.object({ op: z.literal('updateField'), typeId: z.string(), key: z.string(), patch: fieldPatch }),
    z.object({ op: z.literal('removeField'), typeId: z.string(), key: z.string() }),
    z.object({
      op: z.literal('addCategory'),
      typeId: z.string(),
      category: z.object({ id: z.string(), label: z.string(), order: z.number().optional() }).strict(),
    }),
    z.object({
      op: z.literal('updateCategory'),
      typeId: z.string(),
      id: z.string(),
      patch: z.object({ label: z.string().optional(), order: z.number().optional() }).strict(),
    }),
    z.object({ op: z.literal('removeCategory'), typeId: z.string(), id: z.string() }),
  ]);

  server.registerTool(
    'get_schema',
    {
      title: 'Lire le schéma de données',
      description: `Retourne le schéma complet de ${LABEL} (types, champs avec leurs propriétés, catégories, relations, actions), ou d'un seul type avec typeId. Plus détaillé que list_types : à lire avant update_schema.`,
      inputSchema: { typeId: z.string().optional().describe('Limiter à un type') },
    },
    async ({ typeId }) => {
      const schema = await loadSchema();
      if (!typeId) return textResult(schema);
      const type = findType(schema, typeId);
      return type ? textResult(type) : errorResult(`Type inconnu : ${typeId}`);
    },
  );

  server.registerTool(
    'update_schema',
    {
      title: 'Modifier le schéma de données',
      description: `Modifie le schéma de ${LABEL} par des opérations structurées (addField, updateField, removeField, addCategory, updateCategory, removeCategory), tout ou rien. Réservé aux super-utilisateurs ; le serveur valide le schéma entier et en garde une sauvegarde avant d'écrire. Aucun redémarrage : recharger la page pour voir le changement. Une clé de champ ne se renomme pas ; retirer un champ qui contient des données exige force: true (les données restent dans data.json) ; un champ utilisé par un titre, une colonne par défaut, l'agenda ou une relation ne se retire jamais. Créer ou supprimer un type n'est pas possible ici.`,
      inputSchema: {
        changes: z.array(change).min(1).describe('Opérations appliquées dans l\'ordre'),
        force: z.boolean().optional().describe('Autorise le retrait d\'un champ qui contient des données'),
      },
    },
    async ({ changes, force }) => textResult(await postJson('/api/schema', { changes, force: force === true })),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
