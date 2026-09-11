import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { auth } from '$lib/server/auth';
import { listMemberships } from '$lib/server/households';
import { Dec } from '$lib/shared/decimal';
import type { ActorContext } from '$lib/server/pantry';
import { createRecipe } from '$lib/server/recipes';
import type { ValidRecipe } from '$lib/shared/recipe-input';

/** Wipe all tenant data; the shared ingredient catalog and migrations stay. */
export async function resetDb() {
	// FK cascades remove every tenant row; catalog ingredients (owner null) survive.
	await db.execute(sql`delete from household`);
	await db.execute(sql`delete from "user"`);
	await db.execute(sql`delete from ingredient where owner_user_id is not null`);
	// Provider metadata is a shared cache, not tenant data, so no cascade
	// reaches it. Clearing it keeps one test from seeing another's lookups.
	await db.execute(sql`delete from barcode_product`);
	await db.execute(sql`delete from barcode_miss`);
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
