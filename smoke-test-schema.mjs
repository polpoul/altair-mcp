/**
 * Test sans réseau de l'outil update_schema (opération setTitleFields).
 * Usage : node smoke-test-schema.mjs
 * Lance index.js avec un jeton factice et une URL injoignable ; la validation zod a lieu avant
 * le handler, donc aucun appel HTTP n'est émis.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(dir, 'index.js')], {
  cwd: dir,
  env: { ...process.env, ALTAIR_TOKEN: 'test', ALTAIR_BASE_URL: 'http://127.0.0.1:9' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};

const pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    } catch {
      /* ligne non JSON-RPC : ignorée */
    }
  }
});

let nextId = 1;
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

const callUpdate = (changes) => request('tools/call', { name: 'update_schema', arguments: { changes } });

// Rejet attendu par la validation d'entrée (isError ou erreur JSON-RPC), message de validation, pas de réseau.
const expectValidationError = (label, res) => {
  const text = res.error ? JSON.stringify(res.error) : (res.result?.content ?? []).map((c) => c.text).join('\n');
  const rejected = Boolean(res.error) || res.result?.isError === true;
  check(rejected, `${label} : devrait être rejeté (réponse : ${text.slice(0, 200)})`);
  check(/validation|invalid|requis|required|expected|too_small|at least/i.test(text), `${label} : message sans mention de validation (${text.slice(0, 200)})`);
  check(!/ECONNREFUSED|fetch failed|127\.0\.0\.1/i.test(text), `${label} : une tentative réseau a eu lieu (${text.slice(0, 200)})`);
};

async function run() {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-test-schema', version: '1.0.0' },
  });
  check(!init.error, `initialize : ${JSON.stringify(init.error)}`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await request('tools/list', {});
  const tool = list.result?.tools?.find((t) => t.name === 'update_schema');
  check(Boolean(tool), 'update_schema absent de tools/list');
  if (tool) {
    check(tool.description.includes('setTitleFields'), 'la description ne mentionne pas setTitleFields');
    const items = tool.inputSchema?.properties?.changes?.items ?? {};
    const branches = items.anyOf ?? items.oneOf ?? [];
    const ops = branches.map((b) => b.properties?.op?.const);
    for (const op of ['addField', 'updateField', 'removeField', 'addCategory', 'updateCategory', 'removeCategory']) {
      check(ops.includes(op), `opération ${op} absente de l'union`);
    }
    const branch = branches.find((b) => b.properties?.op?.const === 'setTitleFields');
    check(Boolean(branch), 'branche setTitleFields absente de l\'union');
    if (branch) {
      check(branch.required?.includes('typeId') && branch.required?.includes('fields'), 'typeId et fields doivent être requis');
      const f = branch.properties?.fields;
      check(f?.type === 'array' && f?.items?.type === 'string' && f?.minItems === 1, `fields doit être un array de string avec minItems 1 (${JSON.stringify(f)})`);
    }
  }

  expectValidationError('op inconnue', await callUpdate([{ op: 'opInconnue', typeId: 'tache' }]));
  expectValidationError('fields vide', await callUpdate([{ op: 'setTitleFields', typeId: 'tache', fields: [] }]));
  expectValidationError('fields non chaîne', await callUpdate([{ op: 'setTitleFields', typeId: 'tache', fields: [1] }]));
  expectValidationError('fields absent', await callUpdate([{ op: 'setTitleFields', typeId: 'tache' }]));
}

const timer = setTimeout(() => {
  failures.push('délai de 10 s dépassé');
  finish();
}, 10000);

function finish() {
  clearTimeout(timer);
  child.kill();
  if (failures.length) {
    console.error('ÉCHEC :\n- ' + failures.join('\n- '));
    process.exit(1);
  }
  console.log('OK : update_schema / setTitleFields (schéma d\'entrée et rejets de validation)');
  process.exit(0);
}

run().catch((e) => failures.push(`exception : ${e.message}`)).finally(finish);
