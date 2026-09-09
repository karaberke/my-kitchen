#!/usr/bin/env node
/**
 * Production migration runner. Waits for the database, takes an advisory lock
 * so concurrent runners serialise, applies committed migrations from ./drizzle,
 * then exits. Never generates or pushes schema changes.
 *
 * Usage: node scripts/migrate.mjs   (reads DATABASE_URL, DATABASE_SSL)
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LOCK_KEY = 7_281_934_001; // arbitrary stable bigint key for pg_advisory_lock
const url = process.env.DATABASE_URL;
if (!url) {
	console.error('migrate: DATABASE_URL is not set');
	process.exit(2);
}
const ssl = process.env.DATABASE_SSL
	? process.env.DATABASE_SSL === 'require'
		? 'require'
		: { rejectUnauthorized: false }
	: undefined;
const waitSeconds = Number(process.env.MIGRATE_WAIT_SECONDS ?? 120);
const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

async function waitForDatabase() {
	const deadline = Date.now() + waitSeconds * 1000;
	let attempt = 0;
	for (;;) {
		attempt += 1;
		const probe = postgres(url, { max: 1, ssl, connect_timeout: 5, onnotice: () => {} });
		try {
			await probe`select 1`;
			await probe.end();
			return;
		} catch (err) {
			await probe.end({ timeout: 1 }).catch(() => {});
			// Authentication / missing database errors will not fix themselves: fail fast.
			if (['28P01', '28000', '3D000'].includes(err.code)) {
				console.error(`migrate: cannot connect: ${err.message}`);
				process.exit(1);
			}
			if (Date.now() > deadline) {
				console.error(`migrate: database not reachable after ${waitSeconds}s: ${err.message}`);
				process.exit(1);
			}
			if (attempt === 1 || attempt % 5 === 0)
				console.log(`migrate: waiting for database (${err.code ?? err.message})`);
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

await waitForDatabase();
const sql = postgres(url, { max: 1, ssl, onnotice: () => {} });
try {
	console.log('migrate: acquiring advisory lock');
	await sql`select pg_advisory_lock(${LOCK_KEY})`;
	const db = drizzle(sql);
	console.log(`migrate: applying migrations from ${folder}`);
	await migrate(db, { migrationsFolder: folder });
	const [{ count }] = await sql`select count(*)::int as count from drizzle.__drizzle_migrations`;
	console.log(`migrate: done, ${count} migration(s) recorded`);
	await sql`select pg_advisory_unlock(${LOCK_KEY})`;
} catch (err) {
	console.error('migrate: FAILED', err);
	await sql.end({ timeout: 2 }).catch(() => {});
	process.exit(1);
}
await sql.end({ timeout: 5 });
