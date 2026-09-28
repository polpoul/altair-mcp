import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['index.js'],
  env: { ...process.env, ALTAIR_BASE_URL: 'https://axio.vivalink.top', ALTAIR_LABEL: 'axio' },
});

const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('Outils exposés:', tools.tools.map((t) => t.name).join(', '));

const typesRes = await client.callTool({ name: 'list_types', arguments: {} });
const types = JSON.parse(typesRes.content[0].text);
console.log('Types déclarés:', types.types.map((t) => t.id).join(', '));

const tachesRes = await client.callTool({ name: 'list_records', arguments: { typeId: 'tache', filters: { statut: 'En cours' } } });
console.log('Tâches "En cours":', tachesRes.content[0].text);

await client.close();
process.exit(0);
