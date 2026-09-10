import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { serverEnv } from '$lib/server/env';
import { sslOptions } from './ssl';

/**
 * One bounded Postgres.js pool per server process. Never create a client per
 * request. Limits and timeouts are configurable through the environment.
 */
function createClient() {
	const env = serverEnv();
	return postgres(env.DATABASE_URL, {
		max: env.DATABASE_POOL_MAX,
		connect_timeout: env.DATABASE_CONNECT_TIMEOUT_SECONDS,
		idle_timeout: env.DATABASE_IDLE_TIMEOUT_SECONDS,
		ssl: sslOptions(env.DATABASE_SSL),
		prepare: true,
		onnotice: () => {}
	});
}

export const client = createClient();
export const db = drizzle(client, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export async function closeDb(): Promise<void> {
	await client.end({ timeout: 5 });
}
