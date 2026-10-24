import { afterAll } from 'vitest';
import { env as dynamicEnv } from '$env/dynamic/private';
import { startImportProxy } from '../helpers/import-proxy';
import { assertTestDatabaseName, assertTestDatabaseUrl } from '../../scripts/test-database.mjs';

assertTestDatabaseUrl(process.env.DATABASE_URL);
const proxy = await startImportProxy();
afterAll(() => proxy.close());
process.env.IMPORT_PROXY_URL = proxy.url;
// Vite's Svelte virtual module captures its own environment object. Keep that
// effective runtime configuration in sync before serverEnv is first cached.
dynamicEnv.IMPORT_PROXY_URL = proxy.url;
const { client, closeDb } = await import('$lib/server/db');
afterAll(closeDb);
const [{ name }] = await client`select current_database() as name`;
assertTestDatabaseName(name);
