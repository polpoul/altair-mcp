// Test de fumée hors réseau : update_schema expose setListColumns (schéma zod + description).
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['index.js'], {
  env: { ...process.env, ALTAIR_BASE_URL: 'http://127.0.0.1:9', ALTAIR_TOKEN: 'test' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

function fail(msg) {
  console.error(`ECHEC : ${msg}`);
  child.kill();
  process.exit(1);
}

const timer = setTimeout(() => fail('délai global de 15 s dépassé'), 15000);

const pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
  }
});
child.on('exit', (code) => {
  if (code) fail(`le serveur MCP s'est arrêté (code ${code})`);
});

let nextId = 1;
const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

// Retourne le texte d'erreur d'un appel d'outil, ou null si la validation est passée sans erreur.
const callUpdate = async (changes) => {
  const res = await request('tools/call', { name: 'update_schema', arguments: { changes } });
  if (res.error) return { rejected: true, text: res.error.message };
  const text = (res.result.content || []).map((c) => c.text).join('\n');
  return { rejected: res.result.isError === true, text };
};

const init = await request('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'smoke-test-schema', version: '1.0.0' },
});
if (init.error) fail(`initialize : ${init.error.message}`);
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const list = await request('tools/list', {});
const tool = list.result?.tools?.find((t) => t.name === 'update_schema');
if (!tool) fail('outil update_schema absent');

const items = tool.inputSchema?.properties?.changes?.items;
const variants = items?.anyOf || items?.oneOf;
if (!variants) fail('union des opérations introuvable dans changes.items');
const byOp = new Map(variants.map((v) => [v.properties?.op?.const, v]));

const setCols = byOp.get('setListColumns');
if (!setCols) fail('op setListColumns absente de la union');
if (!(setCols.required || []).includes('typeId') || setCols.properties.typeId?.type !== 'string')
  fail('setListColumns doit exiger typeId (texte)');
const cols = setCols.properties.columns;
if (!(setCols.required || []).includes('columns') || cols?.type !== 'array' || cols.items?.type !== 'string')
  fail('setListColumns doit exiger columns (tableau de textes)');

if (!tool.description.includes('setListColumns')) fail('la description de update_schema ne mentionne pas setListColumns');

for (const op of ['addField', 'updateField', 'removeField', 'addCategory', 'updateCategory', 'removeCategory'])
  if (!byOp.has(op)) fail(`régression : op ${op} absente`);
if (byOp.has('inconnue')) fail('une variante accepte une op inconnue');

const unknown = await callUpdate([{ op: 'inconnue' }]);
if (!unknown.rejected) fail(`op inconnue acceptée : ${unknown.text}`);

const badCols = await callUpdate([{ op: 'setListColumns', typeId: 'tache', columns: 'titre' }]);
if (!badCols.rejected) fail(`columns non tableau accepté : ${badCols.text}`);

const goodCols = await callUpdate([{ op: 'setListColumns', typeId: 'tache', columns: ['titre'] }]);
if (/invalid_union|Invalid/.test(goodCols.text)) fail(`columns valide refusé à la validation : ${goodCols.text}`);

clearTimeout(timer);
child.removeAllListeners('exit');
child.kill();
console.log('OK');
process.exit(0);
