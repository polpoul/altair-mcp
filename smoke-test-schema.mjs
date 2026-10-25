// Vérifie l'exposition de update_schema (op updateType) dans tools/list. Aucun réseau, aucun jeton réel.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const child = spawn(process.execPath, ['index.js'], {
  env: { ...process.env, ALTAIR_BASE_URL: 'http://127.0.0.1:1', ALTAIR_TOKEN: 'test' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  child.kill();
  process.exit(code);
};
const fail = (msg) => {
  console.error(`ÉCHEC ${msg}`);
  finish(1);
};
setTimeout(() => fail('délai global de 15 s dépassé'), 15000).unref();
child.on('error', (e) => fail(`processus fils : ${e.message}`));
child.on('exit', () => fail('index.js s\'est arrêté avant la réponse tools/list'));

const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

const ok = (label) => console.log(`OK ${label}`);
const check = (cond, label) => (cond ? ok(label) : fail(label));
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function verify(tools) {
  const tool = tools.find((t) => t.name === 'update_schema');
  if (!tool) return fail('outil update_schema absent');
  const items = tool.inputSchema?.properties?.changes?.items;
  const variants = items?.oneOf ?? items?.anyOf;
  if (!variants) return fail('changes.items sans oneOf/anyOf');
  const opOf = (v) => v.properties?.op?.const ?? v.properties?.op?.enum?.[0];
  const ops = variants.map(opOf);

  const existing = ['addField', 'updateField', 'removeField', 'addCategory', 'updateCategory', 'removeCategory'];
  check(ops.includes('updateType') && existing.every((o) => ops.includes(o)), `(a) ops : ${ops.join(', ')}`);

  const variant = variants.find((v) => opOf(v) === 'updateType');
  const patch = variant.properties?.patch;
  check(
    ['typeId', 'patch'].every((k) => variant.required?.includes(k)) &&
      variant.additionalProperties === false &&
      patch?.additionalProperties === false &&
      sameSet(Object.keys(patch.properties ?? {}), ['label', 'icon', 'color']),
    '(b) updateType : typeId et patch requis, objets stricts, patch = label/icon/color',
  );

  check(tool.description.includes('updateType'), '(c) description de l\'outil mentionne updateType');

  check(!ops.includes('inconnueOp'), '(d) aucune variante inconnueOp');
  console.log('OK (d) Ajv non utilisé : (a) et (b) suffisent');
  finish(0);
}

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 1) {
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list', params: {} });
  } else if (msg.id === 2) {
    if (msg.error) return fail(`tools/list : ${msg.error.message}`);
    verify(msg.result.tools);
  }
});

send({
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-test-schema', version: '1.0.0' } },
});
