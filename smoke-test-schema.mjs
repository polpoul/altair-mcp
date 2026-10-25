import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Sans réseau ni jeton réel : seul le schéma d'entrée publié par tools/list est contrôlé.
const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['index.js'],
  env: { ...process.env, ALTAIR_BASE_URL: 'http://127.0.0.1:9', ALTAIR_TOKEN: 'test' },
});
const client = new Client({ name: 'smoke-test-schema', version: '1.0.0' });

const timer = setTimeout(() => {
  console.error('Timeout 10 s');
  transport.close().finally(() => process.exit(1));
}, 10000);

async function run() {
  await client.connect(transport);
  const tool = (await client.listTools()).tools.find((t) => t.name === 'update_schema');
  check(tool, 'update_schema absent');
  if (!tool) return;

  check(tool.description.includes('setAgenda'), 'description sans setAgenda');

  const items = tool.inputSchema.properties.changes.items;
  const branches = items.oneOf ?? items.anyOf ?? [];
  const opOf = (b) => b.properties?.op?.const ?? b.properties?.op?.enum?.[0];
  const ops = branches.map(opOf).sort();
  const expected = ['addCategory', 'addField', 'removeCategory', 'removeField', 'setAgenda', 'updateCategory', 'updateField'];
  check(JSON.stringify(ops) === JSON.stringify(expected), `ops = ${ops.join(', ')} (attendu : ${expected.join(', ')})`);

  const agenda = branches.find((b) => opOf(b) === 'setAgenda');
  if (agenda) {
    const p = agenda.properties;
    check(p.typeId?.type === 'string', 'typeId doit être string');
    for (const k of ['startField', 'endField']) {
      const t = p[k]?.type;
      const types = Array.isArray(t) ? t : p[k]?.anyOf?.map((x) => x.type);
      check(types?.includes('string') && types?.includes('null'), `${k} doit être string ou null`);
    }
    for (const k of ['op', 'typeId', 'startField', 'endField']) {
      check(agenda.required?.includes(k), `${k} doit être requis`);
    }
  }

  const call = async (changes) => {
    try {
      const r = await client.callTool({ name: 'update_schema', arguments: { changes } });
      return (r.content ?? []).map((c) => c.text ?? '').join('\n');
    } catch (e) {
      return String(e.message);
    }
  };
  const isValidation = (s) => /invalid/i.test(s);

  const unknown = await call([{ op: 'inconnue' }]);
  check(isValidation(unknown), `op inconnue : pas d'erreur de validation (${unknown.slice(0, 120)})`);

  const valid = await call([{ op: 'setAgenda', typeId: 'tache', startField: 'debut', endField: 'fin' }]);
  check(!isValidation(valid), `setAgenda valide rejeté par la validation (${valid.slice(0, 120)})`);

  const partial = await call([{ op: 'setAgenda', typeId: 'tache', startField: 'debut' }]);
  check(isValidation(partial), `setAgenda avec endField absent accepté (${partial.slice(0, 120)})`);
}

try {
  await run();
} catch (e) {
  errors.push(`exception : ${e.stack ?? e}`);
}
clearTimeout(timer);
await client.close().catch(() => {});
if (errors.length) {
  console.error('ÉCHEC :\n- ' + errors.join('\n- '));
  process.exit(1);
}
console.log('OK');
process.exit(0);
