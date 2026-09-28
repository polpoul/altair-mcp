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
 * Aucune authentification n'existe côté serveur à ce jour (CORS ouvert, pas de clé) —
 * voir deploy-vivalink/PLAN-AUTH.md. Ce serveur MCP n'ajoute donc aucune barrière de
 * plus que ce qui est déjà exposé publiquement ; il structure juste l'accès pour Claude.
 *
 * Un seul métier par instance de ce serveur : la variable d'environnement ALTAIR_BASE_URL
 * fixe l'URL cible (ex. https://axio.vivalink.top). Pour piloter plusieurs métiers,
 * enregistrer plusieurs instances de ce serveur MCP avec des noms/URLs différents.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHmac } from 'node:crypto';

const BASE_URL = process.env.ALTAIR_BASE_URL;
if (!BASE_URL) {
  console.error('ALTAIR_BASE_URL manquant (ex. https://axio.vivalink.top)');
  process.exit(1);
}
const LABEL = process.env.ALTAIR_LABEL || new URL(BASE_URL).hostname;

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
  const res = await fetch(new URL(path, BASE_URL));
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(new URL(path, BASE_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

async function loadSchema() {
  return getJson('/assets/schema.json');
}

async function loadData() {
  return getJson('/assets/data.json');
}

async function saveData(file, content) {
  return postJson('/api/save', { file, content });
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
    await saveData('data.json', data);
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

    const data = await loadData();
    const records = data[typeId] || [];
    const record = records.find((r) => r.id === id);
    if (!record) return errorResult(`Aucun enregistrement ${typeId}/${id}`);
    Object.assign(record, fields);
    await saveData('data.json', data);
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
    await saveData('data.json', data);
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

const transport = new StdioServerTransport();
await server.connect(transport);
