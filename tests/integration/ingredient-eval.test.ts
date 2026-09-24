import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { catalogIngredientId, createUser, resetDb } from './helpers';
import { resolveIngredientName, proposeFromProductTitle } from '$lib/server/ingredient-match';
import { createCustomIngredient, searchIngredients } from '$lib/server/ingredients';
import { RESOLVE_CASES, SCAN_CASES, DROPDOWN_CASES } from '$lib/shared/ingredient-match-cases';

describe('ingredient evaluation set', () => {
	beforeEach(resetDb);

	it('resolves every case with no wrong or unwanted automatic link', async () => {
		const user = await createUser('Alice');
		let wrong = 0;
		let missed = 0;
		for (const c of RESOLVE_CASES) {
			const hit = await resolveIngredientName(db, user.id, c.input);
			if (c.expected === null) {
				if (hit) {
					wrong++;
					for (const bad of c.notExpected ?? []) {
						const badId = await catalogIngredientId(bad);
						expect(hit.ingredientId, `"${c.input}" must not link to "${bad}"`).not.toBe(badId);
					}
				}
				expect(hit, `"${c.input}" must stay unresolved`).toBeNull();
			} else {
				const expectedId = await catalogIngredientId(c.expected);
				if (!hit) missed++;
				else if (hit.ingredientId !== expectedId) wrong++;
				expect(hit?.ingredientId, `"${c.input}" must resolve to "${c.expected}"`).toBe(expectedId);
			}
		}
		console.log(
			`[ingredient-eval] resolve: wrong=${wrong} missed=${missed} total=${RESOLVE_CASES.length}`
		);
	});

	it('proposes every scan case with no wrong or unwanted proposal', async () => {
		const user = await createUser('Alice');
		let wrong = 0;
		let missed = 0;
		for (const c of SCAN_CASES) {
			const hit = await proposeFromProductTitle(db, user.id, c.title, c.brand);
			if (c.expected === null) {
				if (hit) wrong++;
				expect(hit, `"${c.title}" must stay unproposed`).toBeNull();
			} else {
				const expectedId = await catalogIngredientId(c.expected);
				if (!hit) missed++;
				else if (hit.ingredientId !== expectedId) wrong++;
				expect(hit?.ingredientId, `"${c.title}" must propose "${c.expected}"`).toBe(expectedId);
			}
		}
		console.log(
			`[ingredient-eval] scan: wrong=${wrong} missed=${missed} total=${SCAN_CASES.length}`
		);
	});

	it('finds every dropdown case in the top 5, deduplicated', async () => {
		const user = await createUser('Alice');
		let hits = 0;
		for (const c of DROPDOWN_CASES) {
			const expectedId = await catalogIngredientId(c.expected);
			const results = await searchIngredients(db, user.id, c.query, 5);
			const ids = results.map((r) => r.id);
			expect(new Set(ids).size, `"${c.query}" results must not repeat an identity`).toBe(
				ids.length
			);
			if (ids.includes(expectedId)) hits++;
			expect(ids, `"${c.query}" must find "${c.expected}" in the top 5`).toContain(expectedId);
		}
		console.log(`[ingredient-eval] dropdown: hits=${hits} total=${DROPDOWN_CASES.length}`);
	});

	it("never returns another user's private identity in the dropdown", async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const secret = await createCustomIngredient(db, bob.id, 'bob secret spice');
		const results = await searchIngredients(db, alice.id, 'bob secret spice', 5);
		expect(results.map((r) => r.id)).not.toContain(secret.id);
	});

	it('ranks an exact private name first, over a catalog prefix or alias hit', async () => {
		const alice = await createUser('Alice');
		await catalogIngredientId('chicken breast'); // present in the catalog for the prefix hit
		const mine = await createCustomIngredient(db, alice.id, 'Chicken');
		const results = await searchIngredients(db, alice.id, 'chicken', 5);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].id).toBe(mine.id);
	});

	it('ranks an exact private name first, over an exact catalog alias', async () => {
		const alice = await createUser('Alice');
		const mine = await createCustomIngredient(db, alice.id, 'Scallions');
		const results = await searchIngredients(db, alice.id, 'scallions', 5);
		expect(results[0].id).toBe(mine.id);
		expect(results.map((r) => r.id)).toContain(await catalogIngredientId('green onion'));
	});

	it('lists each identity at most once', async () => {
		const user = await createUser('Alice');
		const results = await searchIngredients(db, user.id, 'scallions', 5);
		const ids = results.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
