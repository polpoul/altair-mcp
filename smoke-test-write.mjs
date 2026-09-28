import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['index.js'],
  env: { ...process.env, ALTAIR_BASE_URL: 'https://axio.vivalink.top', ALTAIR_LABEL: 'axio' },
});
const client = new Client({ name: 'smoke-test-write', version: '1.0.0' });
await client.connect(transport);

const created = await client.callTool({
  name: 'create_record',
  arguments: { typeId: 'contact', fields: { prenom: 'Test', nom: 'MCP-smoketest', organisation: 'A supprimer' } },
});
console.log('CREATE:', created.content[0].text);
const parsedCreate = JSON.parse(created.content[0].text);
const record = parsedCreate.record ?? parsedCreate;

const updated = await client.callTool({
  name: 'update_record',
  arguments: { typeId: 'contact', id: record.id, fields: { fonction: 'Test mise à jour' } },
});
console.log('UPDATE:', updated.content[0].text);

const deleted = await client.callTool({
  name: 'delete_record',
  arguments: { typeId: 'contact', id: record.id },
});
console.log('DELETE:', deleted.content[0].text);

// vérifie que ça a bien disparu
const after = await client.callTool({ name: 'get_record', arguments: { typeId: 'contact', id: record.id } });
console.log('GET après suppression (doit être une erreur):', after.content[0].text, after.isError);

await client.close();
process.exit(0);
