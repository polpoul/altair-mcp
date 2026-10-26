import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Validation zod de update_schema (toutes les opérations de schéma), sans réseau ni jeton réel :
// le port 9 est fermé, donc une opération valide échoue en « fetch failed », une invalide en « Input validation error ».
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['index.js'],
  env: { ...process.env, ALTAIR_TOKEN: 'test', ALTAIR_BASE_URL: 'http://127.0.0.1:9', ALTAIR_LABEL: 'test' },
});
const client = new Client({ name: 'smoke-test-schema', version: '1.0.0' });
await client.connect(transport);

const check = (label, ok, detail = '') => {
  if (!ok) {
    console.error(`ÉCHEC : ${label} ${detail}`);
    process.exit(1);
  }
  console.log(`OK : ${label}`);
};
const run = async (changes) => {
  try {
    const res = await client.callTool({ name: 'update_schema', arguments: { changes } });
    return { isError: res.isError === true, text: res.content?.[0]?.text ?? '' };
  } catch (e) {
    return { isError: true, text: e.message };
  }
};

const { tools } = await client.listTools();
const tool = tools.find((t) => t.name === 'update_schema');
check('update_schema présent', !!tool);

const variants = tool.inputSchema.properties.changes.items.anyOf;
const ops = variants.map((v) => v.properties.op.const);
const existing = ['addField', 'updateField', 'removeField', 'addCategory', 'updateCategory', 'removeCategory'];
const added = ['updateType', 'setTitleFields', 'setListColumns', 'setAgenda', 'addType', 'removeType', 'addRelation', 'removeRelation'];
check(`${existing.length + added.length} opérations dans l'union`, [...existing, ...added].every((o) => ops.includes(o)) && ops.length === existing.length + added.length, JSON.stringify(ops));

const required = {
  updateType: ['op', 'typeId', 'patch'],
  setTitleFields: ['op', 'typeId', 'fields'],
  setListColumns: ['op', 'typeId', 'columns'],
  setAgenda: ['op', 'typeId', 'startField', 'endField'],
  addType: ['op', 'id', 'label'],
  removeType: ['op', 'id'],
  addRelation: ['op', 'from', 'to', 'via', 'label'],
  removeRelation: ['op', 'from', 'to', 'via'],
};
for (const [op, keys] of Object.entries(required)) {
  const variant = variants.find((v) => v.properties.op.const === op);
  check(`${op} : champs requis`, keys.every((k) => variant.required.includes(k)) && variant.required.length === keys.length, JSON.stringify(variant.required));
}
const addType = variants.find((v) => v.properties.op.const === 'addType');
check('addType : propriétés', ['icon', 'color', 'categories', 'fields', 'titleFields', 'listColumns'].every((k) => k in addType.properties));
const updateType = variants.find((v) => v.properties.op.const === 'updateType');
check('updateType : patch = label/icon/color', JSON.stringify(Object.keys(updateType.properties.patch.properties).sort()) === JSON.stringify(['color', 'icon', 'label']));

const addCategory = variants.find((v) => v.properties.op.const === 'addCategory');
const updateCategory = variants.find((v) => v.properties.op.const === 'updateCategory');
check('addCategory : category accepte bare', 'bare' in addCategory.properties.category.properties);
check('updateCategory : patch accepte bare', 'bare' in updateCategory.properties.patch.properties);
check('description mentionne bare', tool.description.includes('bare'));

for (const op of added) {
  check(`description mentionne ${op}`, tool.description.includes(op));
}
check('ancienne restriction retirée', !tool.description.includes("Créer ou supprimer un type n'est pas possible"));

const invalid = [
  ['opération inconnue (dropType)', [{ op: 'dropType', id: 'x' }]],
  ['addType sans label', [{ op: 'addType', id: 'acteur' }]],
  ['addType avec propriété inconnue', [{ op: 'addType', id: 'acteur', label: 'Acteur', inconnu: 1 }]],
  ['updateType avec clé de patch inconnue', [{ op: 'updateType', typeId: 'tache', patch: { id: 'autre' } }]],
  ['setTitleFields avec liste vide', [{ op: 'setTitleFields', typeId: 'tache', fields: [] }]],
  ['setListColumns sans columns', [{ op: 'setListColumns', typeId: 'tache' }]],
  ['setAgenda sans endField', [{ op: 'setAgenda', typeId: 'tache', startField: 'debut' }]],
  ['updateCategory avec bare non booléen', [{ op: 'updateCategory', typeId: 'note', id: 'contenu', patch: { bare: 'oui' } }]],
  ['updateCategory avec propriété de patch inconnue', [{ op: 'updateCategory', typeId: 'note', id: 'contenu', patch: { inconnu: true } }]],
  ['addCategory avec bare non booléen', [{ op: 'addCategory', typeId: 'note', category: { id: 'bloc', label: 'Bloc', bare: 'oui' } }]],
  ['addCategory avec bare null (retrait impossible à la création)', [{ op: 'addCategory', typeId: 'note', category: { id: 'bloc', label: 'Bloc', bare: null } }]],
];
for (const [label, changes] of invalid) {
  const r = await run(changes);
  check(`${label} : refusé`, r.isError && r.text.includes('Input validation error'), r.text);
}

const valid = [
  ['updateType', { op: 'updateType', typeId: 'tache', patch: { label: 'Tâches', icon: 'task_alt', color: '#4C78A8' } }],
  ['setTitleFields', { op: 'setTitleFields', typeId: 'tache', fields: ['titre'] }],
  ['setListColumns', { op: 'setListColumns', typeId: 'tache', columns: ['statut', 'projetId.nom'] }],
  ['setAgenda', { op: 'setAgenda', typeId: 'tache', startField: 'debut', endField: 'fin' }],
  ['setAgenda (retrait)', { op: 'setAgenda', typeId: 'tache', startField: null, endField: null }],
  ['updateCategory bare true', { op: 'updateCategory', typeId: 'note', id: 'contenu', patch: { bare: true } }],
  ['updateCategory bare false', { op: 'updateCategory', typeId: 'note', id: 'contenu', patch: { bare: false } }],
  ['updateCategory bare null (retrait)', { op: 'updateCategory', typeId: 'note', id: 'contenu', patch: { bare: null } }],
  ['updateCategory bare avec label', { op: 'updateCategory', typeId: 'note', id: 'contenu', patch: { label: 'Contenu', bare: true } }],
  ['addCategory bare true', { op: 'addCategory', typeId: 'note', category: { id: 'bloc', label: 'Bloc', bare: true } }],
  [
    'addType complet (acteur)',
    {
      op: 'addType',
      id: 'acteur',
      label: 'Acteur',
      icon: 'person',
      color: '#4C78A8',
      categories: [{ id: 'general', label: 'Général', order: 0 }],
      fields: [
        { key: 'nom', label: 'Nom', category: 'general' },
        { key: 'clientId', label: 'Contact', category: 'general' },
        { key: 'tacheId', label: 'Tâche', category: 'general' },
      ],
      titleFields: ['nom'],
      listColumns: ['nom', 'clientId', 'tacheId'],
    },
  ],
  ['removeType', { op: 'removeType', id: 'acteur' }],
  ['addRelation', { op: 'addRelation', from: 'tache', to: 'acteur', via: 'tacheId', label: 'Acteurs' }],
  ['removeRelation', { op: 'removeRelation', from: 'tache', to: 'acteur', via: 'tacheId' }],
];
for (const [label, change] of valid) {
  const r = await run([change]);
  check(`${label} passe la validation`, r.isError && !r.text.includes('Input validation error') && r.text.includes('fetch failed'), r.text);
}

await client.close();
process.exit(0);
