import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertTestDatabaseUrl } from './test-database.mjs';
import { startImportProxy } from '../tests/helpers/import-proxy.ts';
import {
	CHAT_STUB_BASE_URL,
	CHAT_STUB_API_KEY,
	CHAT_STUB_MODEL
} from '../tests/helpers/chat-stub.ts';

// Validate the effective environment, including variables inherited from the shell,
// before migrations or the app can import anything that connects to the database.
assertTestDatabaseUrl(process.env.DATABASE_URL);
const migration = spawnSync(
	process.execPath,
	[fileURLToPath(new URL('./migrate.mjs', import.meta.url)), '--test'],
	{ stdio: 'inherit', env: process.env }
);
if (migration.error || migration.status !== 0) process.exit(migration.status ?? 1);

const proxy = await startImportProxy();
process.env.IMPORT_PROXY_URL = proxy.url;
// Ordinary browser tests keep the assistant off. The separate chat suite only
// contacts its local stub, regardless of any inherited provider credentials.
process.env.LLM_BASE_URL = '';
process.env.LLM_FALLBACK_BASE_URL = '';
if (process.env.E2E_CHAT_STUB === '1') {
	process.env.LLM_BASE_URL = CHAT_STUB_BASE_URL;
	process.env.LLM_API_KEY = CHAT_STUB_API_KEY;
	process.env.LLM_MODEL = CHAT_STUB_MODEL;
}
for (const signal of ['SIGTERM', 'SIGINT']) {
	process.once(signal, () => void proxy.close());
}
process.env.HOST = '127.0.0.1';
process.env.PORT = '4173';
process.env.BODY_SIZE_LIMIT = '6M';
try {
	await import('../build/index.js');
} catch (err) {
	await proxy.close();
	throw err;
}
