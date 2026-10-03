import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Documents joints, de bout en bout, sur l'instance réelle : crée une note « MCP-smoketest », y joint un
// fichier texte, le relit, le télécharge, le retire, puis supprime la note. Exige ALTAIR_TOKEN.
if (!process.env.ALTAIR_TOKEN) {
  console.error('ALTAIR_TOKEN manquant');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['index.js'],
  env: { ...process.env, ALTAIR_BASE_URL: 'https://axio.vivalink.top', ALTAIR_LABEL: 'axio' },
});
const client = new Client({ name: 'smoke-test-files', version: '1.0.0' });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  console.log(`${name}${res.isError ? ' (ERREUR)' : ''}:`, text.length > 300 ? `${text.slice(0, 300)}…` : text);
  return { res, data: res.isError ? null : JSON.parse(text) };
};

const folder = mkdtempSync(join(tmpdir(), 'mcp-files-'));
const source = join(folder, 'smoketest.txt');
const content = `Contenu de test ${Date.now()}\n`;
writeFileSync(source, content);

let noteId = null;
let failed = false;
try {
  const created = await call('create_record', { typeId: 'note', fields: { titre: 'MCP-smoketest' } });
  noteId = (created.data.record ?? created.data).id;

  await call('attach_file', { typeId: 'note', id: noteId, field: 'document', path: source });
  const info = await call('get_file_info', { typeId: 'note', id: noteId, field: 'document' });
  if (info.data?.fichier?.nom !== 'smoketest.txt') throw new Error('métadonnées inattendues');

  const downloaded = await call('download_file', { typeId: 'note', id: noteId, field: 'document', directory: join(folder, 'dl') });
  if (readFileSync(downloaded.data.path, 'utf-8') !== content) throw new Error('contenu téléchargé différent');

  const refused = await call('update_record', { typeId: 'note', id: noteId, fields: { document: '{}' } });
  if (!refused.res.isError) throw new Error('update_record aurait dû refuser un champ file');

  await call('remove_file', { typeId: 'note', id: noteId, field: 'document' });
  const after = await call('get_file_info', { typeId: 'note', id: noteId, field: 'document' });
  if (after.data?.fichier !== null) throw new Error('le fichier devrait être retiré');
  console.log('OK');
} catch (e) {
  failed = true;
  console.error('ÉCHEC :', e.message);
} finally {
  if (noteId) await call('delete_record', { typeId: 'note', id: noteId });
  await client.close();
}
process.exit(failed ? 1 : 0);
