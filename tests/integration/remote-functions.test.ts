import { beforeEach, describe, expect, it } from 'vitest';
import {
	catalogIngredientId,
	createUser,
	opId,
	requestAs,
	resetDb,
	type TestUser
} from './helpers';
import { addStock } from '$lib/server/pantry';
import { suggestIngredients } from '$lib/server/ingredients';
import { matchIngredient } from '$lib/server/ingredient-match';
import { pantryLotsFor } from '$lib/server/cooking';
import { scanBarcode } from '$lib/server/barcode/lookup';
import { revisionsFor } from '$lib/server/households';
import { undoFor } from '$lib/server/undo';
import { reopenListFor } from '$lib/server/grocery';
import type { ProviderAdapter } from '$lib/server/barcode/types';
import { Dec } from '$lib/shared/decimal';

/**
 * The handlers behind src/lib/remote/*.remote.ts. Each is called the way
 * `remote()` calls it: with the request event and the validated argument.
 */

let alice: TestUser;
let bob: TestUser;
let chicken: string;

beforeEach(async () => {
	await resetDb();
	alice = await createUser('Alice');
	bob = await createUser('Bob');
	chicken = await catalogIngredientId('chicken breast');
});

async function stockChicken(user: TestUser) {
	return addStock(user.ctx, {
		operationId: opId(),
		ingredientId: chicken,
		newIngredientName: null,
		quantity: Dec.from('500'),
		unit: 'g',
		location: 'Fridge',
		expiresOn: null,
		note: ''
	});
}

/** No provider enabled: a lookup never leaves the process. */
const offline: ProviderAdapter[] = [];

describe('ingredient queries', () => {
	it('refuses a signed-out caller', async () => {
		await expect(suggestIngredients(requestAs(null), { q: 'chick' })).rejects.toMatchObject({
			status: 401
		});
		await expect(matchIngredient(requestAs(null), { name: 'chicken' })).rejects.toMatchObject({
			status: 401
		});
	});

	it('suggests catalog names and clamps the limit', async () => {
		const items = await suggestIngredients(requestAs(alice), { q: 'chicken', limit: 100 });
		expect(items.map((i) => i.id)).toContain(chicken);
		expect(items.length).toBeLessThanOrEqual(12);
		expect(await suggestIngredients(requestAs(alice), { q: 'chicken', limit: 1 })).toHaveLength(1);
	});

	it('proposes the catalog match for a written name, and nothing for a blank one', async () => {
		const { match } = await matchIngredient(requestAs(alice), { name: 'chicken breast' });
		expect(match?.ingredientId).toBe(chicken);
		expect(await matchIngredient(requestAs(alice), { name: '   ' })).toEqual({ match: null });
	});
});

describe('pantryLots', () => {
	const arg = () => ({ ingredient: chicken, unit: 'g', convention: 'metric' });

	it('lists the lots of the active household', async () => {
		await stockChicken(alice);
		const { lots } = await pantryLotsFor(requestAs(alice), arg());
		expect(lots).toHaveLength(1);
		expect(lots[0]).toMatchObject({ quantity: '500', unit: 'g', inRequestedUnit: '500' });
	});

	it("refuses another household's lots and a malformed id", async () => {
		await stockChicken(alice);
		await expect(pantryLotsFor(requestAs(bob, alice.householdId), arg())).rejects.toMatchObject({
			status: 403
		});
		await expect(
			pantryLotsFor(requestAs(alice), { ...arg(), ingredient: 'not-a-uuid' })
		).rejects.toMatchObject({ status: 400 });
		await expect(pantryLotsFor(requestAs(null), arg())).rejects.toMatchObject({ status: 401 });
	});
});

describe('barcodeLookup', () => {
	it('answers an unreadable number instead of failing', async () => {
		const answer = await scanBarcode(
			requestAs(alice),
			{ code: '12345670', symbology: null },
			offline
		);
		expect(answer).toMatchObject({ ok: false, reason: 'ambiguous_length' });
	});

	it('looks up a valid number for the household', async () => {
		const answer = await scanBarcode(
			requestAs(alice),
			{ code: '012345678905', symbology: 'upc_a' },
			offline
		);
		expect(answer).toMatchObject({ ok: true, lookup: { outcome: 'no_providers' } });
	});

	it('refuses a non-member and sends a signed-out caller to login', async () => {
		const arg = { code: '012345678905', symbology: null };
		await expect(
			scanBarcode(requestAs(bob, alice.householdId), arg, offline)
		).rejects.toMatchObject({ status: 403 });
		await expect(scanBarcode(requestAs(null), arg, offline)).rejects.toMatchObject({
			status: 303
		});
	});
});

describe('householdRevisions', () => {
	it('returns the counters of the active household and moves with a write', async () => {
		const before = await revisionsFor(requestAs(alice), {});
		expect(before.household).toBe(alice.householdId);
		await stockChicken(alice);
		const after = await revisionsFor(requestAs(alice), { household: alice.householdId });
		expect(after.pantry).toBeGreaterThan(before.pantry);
	});

	it("refuses another household's counters", async () => {
		await expect(
			revisionsFor(requestAs(bob), { household: alice.householdId })
		).rejects.toMatchObject({ status: 403 });
		await expect(revisionsFor(requestAs(null), {})).rejects.toMatchObject({ status: 401 });
	});
});

describe('undo command', () => {
	it('reverses a pantry event once', async () => {
		const { eventId } = (await stockChicken(alice)).result;
		await undoFor(requestAs(alice), { operationId: opId(), eventId });
		const { lots } = await pantryLotsFor(requestAs(alice), {
			ingredient: chicken,
			unit: null,
			convention: 'metric'
		});
		expect(lots).toHaveLength(0);
	});

	it('needs an operation id and stays inside the active household', async () => {
		const { eventId } = (await stockChicken(alice)).result;
		await expect(undoFor(requestAs(alice), { operationId: 'nope', eventId })).rejects.toMatchObject(
			{ status: 400 }
		);
		await expect(undoFor(requestAs(bob), { operationId: opId(), eventId })).rejects.toMatchObject({
			status: 404
		});
	});
});

describe('reopenList command', () => {
	it('answers 404 for a malformed list id', async () => {
		await expect(
			reopenListFor(requestAs(alice), { listId: 'nope', expectedRevision: 1 })
		).rejects.toMatchObject({ status: 404 });
	});
});
