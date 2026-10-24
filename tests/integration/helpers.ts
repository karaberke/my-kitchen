import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { auth } from '$lib/server/auth';
import { listMemberships } from '$lib/server/households';
import { Dec } from '$lib/shared/decimal';
import type { ActorContext } from '$lib/server/access';
import { createRecipe } from '$lib/server/recipes';
import type { ValidRecipe } from '$lib/shared/recipe-input';
import { sslOptions } from '$lib/server/db/ssl';
import { assertTestDatabaseName, assertTestDatabaseUrl } from '../../scripts/test-database.mjs';

/** Wipe all tenant data; the shared ingredient catalog and migrations stay. */
export async function resetDb() {
	assertTestDatabaseUrl(process.env.DATABASE_URL);
	await db.transaction(async (tx) => {
		const [database] = await tx.execute<{ name: string }>(sql`select current_database() as name`);
		assertTestDatabaseName(database.name);
		// FK cascades remove every tenant row; catalog ingredients (owner null) survive.
		await tx.execute(sql`delete from household`);
		await tx.execute(sql`delete from "user"`);
		await tx.execute(sql`delete from ingredient where owner_user_id is not null`);
		// Provider metadata is a shared cache, not tenant data, so no cascade
		// reaches it. Clearing it keeps one test from seeing another's lookups.
		await tx.execute(sql`delete from barcode_product`);
		await tx.execute(sql`delete from barcode_miss`);
	});
}

/** Hold a real transaction open; a separate connection observes only its blocking chain. */
export async function holdDatabaseTransaction(
	hold: (tx: postgres.TransactionSql) => Promise<unknown>
) {
	const control = postgres(assertTestDatabaseUrl(process.env.DATABASE_URL), {
		max: 2,
		ssl: sslOptions(process.env.DATABASE_SSL ?? ''),
		onnotice: () => {}
	});
	const ready = Promise.withResolvers<number>();
	const release = Promise.withResolvers<void>();
	const transaction = control.begin(async (tx) => {
		const [{ name, pid }] = await tx<{ name: string; pid: number }[]>`
			select current_database() as name, pg_backend_pid() as pid`;
		assertTestDatabaseName(name);
		await hold(tx);
		ready.resolve(pid);
		await release.promise;
	});
	void transaction.catch(ready.reject);
	let pid: number;
	try {
		pid = await ready.promise;
	} catch (err) {
		await control.end({ timeout: 1 });
		throw err;
	}
	return {
		async waitForBlocked(count = 1, completed: () => boolean = () => false) {
			await vi.waitUntil(
				async () => {
					if (completed()) return true;
					const [{ n }] = await control<{ n: number }[]>`
						with recursive blocked(pid) as (
							select ${pid}::int
							union
							select activity.pid from pg_stat_activity activity
							join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
						)
						select count(*)::int as n from blocked where pid <> ${pid}`;
					return n >= count;
				},
				{ timeout: 10_000, interval: 10 }
			);
		},
		async release() {
			release.resolve();
			try {
				await transaction;
			} finally {
				await control.end({ timeout: 1 });
			}
		}
	};
}

export interface TestUser {
	id: string;
	name: string;
	email: string;
	householdId: string;
	ctx: ActorContext;
}

let counter = 0;

export async function createUser(name: string): Promise<TestUser> {
	counter++;
	const email = `${name.toLowerCase().replace(/[^a-z]/g, '')}${counter}-${randomUUID().slice(0, 6)}@example.test`;
	const res = await auth.api.signUpEmail({
		body: { name, email, password: 'correct horse battery' }
	});
	const userId = res.user.id;
	const memberships = await listMemberships(db, userId);
	const householdId = memberships[0].householdId;
	return { id: userId, name, email, householdId, ctx: { userId, actorName: name, householdId } };
}

/**
 * The request event a remote-function handler sees for `user` (null: signed
 * out), with `householdId` as the active household (default: their own). Only
 * the fields `hooks.server.ts` resolves are set.
 */
export function requestAs(user: TestUser | null, householdId = user?.householdId): RequestEvent {
	const locals: Partial<App.Locals> = {
		user: user ? ({ id: user.id, name: user.name, email: user.email } as App.Locals['user']) : null,
		household: user && householdId ? { id: householdId, name: user.name, role: 'owner' } : null
	};
	return {
		locals,
		url: new URL('http://localhost/'),
		request: new Request('http://localhost/')
	} as unknown as RequestEvent;
}

export function opId(): string {
	return randomUUID();
}

export const d = (s: string | number) => Dec.from(s);

export function recipeInput(
	partial: Partial<ValidRecipe> & { ingredients: ValidRecipe['ingredients'] }
): ValidRecipe {
	return {
		title: 'Test recipe',
		description: '',
		baseServings: d(4),
		yieldNote: '',
		prepMinutes: null,
		cookMinutes: null,
		source: '',
		notes: '',
		tags: [],
		convention: 'metric',
		status: 'active',
		steps: [{ position: 0, sectionTitle: '', text: 'Cook it.' }],
		...partial
	};
}

export async function catalogIngredientId(name: string): Promise<string> {
	const rows = await db.execute<{ id: string }>(
		sql`select id from ingredient where owner_user_id is null and name = ${name}`
	);
	const row = rows[0];
	if (!row) throw new Error(`catalog ingredient ${name} missing`);
	return row.id;
}

export async function makeChickenRecipe(
	user: TestUser,
	title: string,
	grams: string,
	servings = 4
): Promise<string> {
	const chicken = await catalogIngredientId('chicken breast');
	return createRecipe(
		user.id,
		recipeInput({
			title,
			baseServings: d(servings),
			ingredients: [
				{
					position: 0,
					name: 'chicken breast',
					ingredientId: chicken,
					amount: d(grams),
					unit: 'g',
					preparation: 'diced',
					groupName: '',
					optional: false,
					createIdentity: false
				}
			]
		})
	);
}
