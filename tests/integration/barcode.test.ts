import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { barcodeLinks, barcodeMisses, barcodeProducts } from '$lib/server/db/schema';
import { catalogIngredientId, createUser, d, opId, resetDb } from './helpers';
import { addStock, getPantryOverview } from '$lib/server/pantry';
import { acceptInvite, createInvite } from '$lib/server/households';
import { lookupBarcode, resetBarcodeInFlight } from '$lib/server/barcode/lookup';
import { suggestionFor } from '$lib/server/barcode/suggest';
import { identifyManual } from '$lib/shared/gtin';
import { Dec } from '$lib/shared/decimal';
import { pantryAmount } from '$lib/shared/package-size';
import type { ProviderAdapter, ProviderResult } from '$lib/server/barcode/types';
import type { BarcodeSource } from '$lib/server/db/schema';

const CODE = '012345678905';
const GTIN = '00012345678905';

const identity = (raw = CODE) => {
	const r = identifyManual(raw);
	if (!r.ok) throw new Error(r.message);
	return r.identity;
};

/** A provider that answers however a test wants, and counts the asking. */
function stub(source: BarcodeSource, answer: () => ProviderResult, enabled = true) {
	const state = { calls: 0 };
	const adapter: ProviderAdapter = {
		source,
		enabled: () => enabled,
		lookup: async () => {
			state.calls++;
			return answer();
		}
	};
	return { adapter, state };
}

const peanutButter = (source: BarcodeSource): ProviderResult => ({
	status: 'found',
	product: {
		source,
		gtin: GTIN,
		sourceRef: source === 'usda' ? '333' : CODE,
		sourceVersion: source === 'off' ? '17' : null,
		sourceDate: '2023-06-15',
		brand: 'Acme',
		name: 'Creamy peanut butter',
		packageAmount: source === 'off' ? Dec.from('454') : null,
		packageUnit: source === 'off' ? 'g' : null,
		packageLabelText: '16 oz (454 g)',
		servingAmount: Dec.from('32'),
		servingUnit: 'g',
		servingBasis: 'per_100g',
		nutrients: [
			{
				nutrientId: source === 'usda' ? 1003 : null,
				nutrientNumber: source === 'usda' ? '203' : 'proteins',
				name: 'Protein',
				unit: 'g',
				value: Dec.from('25'),
				basis: 'per_100g'
			}
		]
	}
});

describe('barcode lookup', () => {
	beforeEach(async () => {
		await resetDb();
		resetBarcodeInFlight();
	});

	it('asks a provider once, then answers from the cache', async () => {
		const alice = await createUser('Alice');
		const usda = stub('usda', () => peanutButter('usda'));
		const off = stub('off', () => ({ status: 'missing' }));

		const first = await lookupBarcode(identity(), alice.householdId, [usda.adapter, off.adapter]);
		expect(first.outcome).toBe('found');
		expect(first.product?.source).toBe('usda');
		expect(usda.state.calls).toBe(1);
		// The first source answered, so the second was never needed.
		expect(off.state.calls).toBe(0);

		const second = await lookupBarcode(identity(), alice.householdId, [usda.adapter, off.adapter]);
		expect(second.outcome).toBe('found');
		expect(second.product?.name).toBe('Creamy peanut butter');
		expect(usda.state.calls).toBe(1);
		expect(second.sources[0]).toMatchObject({ source: 'usda', status: 'found', cached: true });
	});

	it('remembers which source confirmed a miss, and falls through to the next', async () => {
		const alice = await createUser('Alice');
		const usda = stub('usda', () => ({ status: 'missing' }));
		const off = stub('off', () => peanutButter('off'));

		const first = await lookupBarcode(identity(), alice.householdId, [usda.adapter, off.adapter]);
		expect(first.outcome).toBe('found');
		expect(first.product?.source).toBe('off');

		const misses = await db.select().from(barcodeMisses).where(eq(barcodeMisses.gtin, GTIN));
		expect(misses.map((m) => m.source)).toEqual(['usda']);

		const second = await lookupBarcode(identity(), alice.householdId, [usda.adapter, off.adapter]);
		expect(usda.state.calls).toBe(1);
		expect(off.state.calls).toBe(1);
		expect(second.sources).toEqual([
			{ source: 'usda', status: 'missing', cached: true },
			{ source: 'off', status: 'found', cached: true }
		]);
		expect(second.product?.source).toBe('off');
	});

	it('reports a product no enabled source holds as not found', async () => {
		const alice = await createUser('Alice');
		const usda = stub('usda', () => ({ status: 'missing' }));
		const off = stub('off', () => ({ status: 'missing' }));
		const r = await lookupBarcode(identity(), alice.householdId, [usda.adapter, off.adapter]);
		expect(r.outcome).toBe('not_found');
		expect(r.product).toBeNull();
	});

	it('never stores an outage or a throttle as a confirmed miss', async () => {
		const alice = await createUser('Alice');
		const usda = stub('usda', () => ({ status: 'unavailable', reason: 'timeout' }));
		const off = stub('off', () => ({ status: 'rate_limited', retryAfterSeconds: 30 }));

		const first = await lookupBarcode(identity(), alice.householdId, [usda.adapter, off.adapter]);
		expect(first.outcome).toBe('unavailable');
		expect(await db.select().from(barcodeMisses)).toEqual([]);

		// The next scan asks again rather than repeating a stored non-answer.
		await lookupBarcode(identity(), alice.householdId, [usda.adapter, off.adapter]);
		expect(usda.state.calls).toBe(2);
		expect(off.state.calls).toBe(2);
	});

	it('works with no provider configured at all', async () => {
		const alice = await createUser('Alice');
		const usda = stub('usda', () => peanutButter('usda'), false);
		const off = stub('off', () => peanutButter('off'), false);
		const r = await lookupBarcode(identity(), alice.householdId, [usda.adapter, off.adapter]);
		expect(r.outcome).toBe('no_providers');
		expect(usda.state.calls).toBe(0);
		expect(r.sources.every((s) => s.status === 'disabled')).toBe(true);
	});

	it('keeps the source on a cached record, so its licence stays attached', async () => {
		const alice = await createUser('Alice');
		const off = stub('off', () => peanutButter('off'));
		await lookupBarcode(identity(), alice.householdId, [off.adapter]);
		const [row] = await db.select().from(barcodeProducts).where(eq(barcodeProducts.gtin, GTIN));
		expect(row.source).toBe('off');
		expect(row.sourceVersion).toBe('17');
		expect(row.sourceDate).toBe('2023-06-15');
	});
});

describe('barcode save', () => {
	beforeEach(async () => {
		await resetDb();
		resetBarcodeInFlight();
	});

	const addScanned = async (
		ctx: Awaited<ReturnType<typeof createUser>>['ctx'],
		ingredientId: string,
		options: { operationId?: string; packageCount?: number; per?: string } = {}
	) => {
		const per = Dec.from(options.per ?? '500');
		const total = pantryAmount({ amount: per, unit: 'g' }, options.packageCount ?? 1);
		if (!total.ok) throw new Error(total.error);
		return addStock(ctx, {
			operationId: options.operationId ?? opId(),
			ingredientId,
			newIngredientName: null,
			quantity: total.quantity,
			unit: total.unit,
			location: '',
			expiresOn: null,
			note: '',
			barcode: {
				gtin: GTIN,
				displayName: 'Creamy peanut butter',
				brand: 'Acme',
				packageQuantity: per,
				packageUnit: 'g',
				packageCount: options.packageCount ?? 1,
				packageLabelText: '16 oz (454 g)',
				origin: 'usda'
			}
		});
	};

	it('adds package size times package count as one lot', async () => {
		const alice = await createUser('Alice');
		const chicken = await catalogIngredientId('chicken breast');
		await addScanned(alice.ctx, chicken, { per: '500', packageCount: 2 });
		const overview = await getPantryOverview(db, alice.householdId, {
			q: '',
			location: null,
			filter: 'all'
		});
		const group = overview.groups.find((g) => g.ingredientId === chicken);
		expect(group?.lots).toHaveLength(1);
		expect(Dec.from(group!.lots[0].quantity).toString()).toBe('1000');
	});

	it('recognises the product next time, without asking any provider', async () => {
		const alice = await createUser('Alice');
		const chicken = await catalogIngredientId('chicken breast');
		await addScanned(alice.ctx, chicken, { per: '500', packageCount: 2 });

		const usda = stub('usda', () => peanutButter('usda'));
		const r = await lookupBarcode(identity(), alice.householdId, [usda.adapter]);
		expect(r.outcome).toBe('known');
		expect(r.link?.ingredientId).toBe(chicken);

		const suggestion = suggestionFor(r);
		expect(suggestion.from).toBe('household');
		// What one package holds, not what was added.
		expect(suggestion.packageQuantity).toBe('500');
		expect(suggestion.packageCount).toBe(2);
	});

	it('lets the household correct the link without a refresh undoing it', async () => {
		const alice = await createUser('Alice');
		const chicken = await catalogIngredientId('chicken breast');
		await addScanned(alice.ctx, chicken, { per: '500' });
		await addScanned(alice.ctx, chicken, { per: '397' });

		const usda = stub('usda', () => peanutButter('usda'));
		const r = await lookupBarcode(identity(), alice.householdId, [usda.adapter]);
		expect(suggestionFor(r).packageQuantity).toBe('397');
		expect(r.product?.source).toBe('usda');
	});

	it('a retry of one Add never adds stock twice', async () => {
		const alice = await createUser('Alice');
		const chicken = await catalogIngredientId('chicken breast');
		const id = opId();
		const first = await addScanned(alice.ctx, chicken, { operationId: id });
		const retry = await addScanned(alice.ctx, chicken, { operationId: id });
		expect(retry.replayed).toBe(true);
		expect(retry.result.lotId).toBe(first.result.lotId);

		const overview = await getPantryOverview(db, alice.householdId, {
			q: '',
			location: null,
			filter: 'all'
		});
		expect(overview.groups.find((g) => g.ingredientId === chicken)?.lots).toHaveLength(1);
	});

	it('two concurrent retries of one Add still add stock once', async () => {
		const alice = await createUser('Alice');
		const chicken = await catalogIngredientId('chicken breast');
		const id = opId();
		const results = await Promise.all([
			addScanned(alice.ctx, chicken, { operationId: id }),
			addScanned(alice.ctx, chicken, { operationId: id })
		]);
		expect(new Set(results.map((r) => r.result.lotId)).size).toBe(1);
		const overview = await getPantryOverview(db, alice.householdId, {
			q: '',
			location: null,
			filter: 'all'
		});
		expect(overview.groups.find((g) => g.ingredientId === chicken)?.lots).toHaveLength(1);
	});

	it('a new operation id is a second purchase, and a second lot', async () => {
		const alice = await createUser('Alice');
		const chicken = await catalogIngredientId('chicken breast');
		await addScanned(alice.ctx, chicken);
		await addScanned(alice.ctx, chicken);
		const overview = await getPantryOverview(db, alice.householdId, {
			q: '',
			location: null,
			filter: 'all'
		});
		expect(overview.groups.find((g) => g.ingredientId === chicken)?.lots).toHaveLength(2);
	});
});

describe('barcode ownership', () => {
	beforeEach(async () => {
		await resetDb();
		resetBarcodeInFlight();
	});

	it('does not leak one household link to another', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const chicken = await catalogIngredientId('chicken breast');
		await addStock(alice.ctx, {
			operationId: opId(),
			ingredientId: chicken,
			newIngredientName: null,
			quantity: d(500),
			unit: 'g',
			location: '',
			expiresOn: null,
			note: '',
			barcode: {
				gtin: GTIN,
				displayName: 'Alice peanut butter',
				brand: 'Acme',
				packageQuantity: d(500),
				packageUnit: 'g',
				packageCount: 1,
				packageLabelText: '',
				origin: 'manual'
			}
		});

		const usda = stub('usda', () => ({ status: 'missing' }));
		const mine = await lookupBarcode(identity(), alice.householdId, [usda.adapter]);
		expect(mine.link?.displayName).toBe('Alice peanut butter');

		const theirs = await lookupBarcode(identity(), bob.householdId, [usda.adapter]);
		expect(theirs.link).toBeNull();
		expect(theirs.outcome).toBe('not_found');
	});

	it('one household cannot change another household defaults', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const chicken = await catalogIngredientId('chicken breast');
		const link = (ctx: typeof alice.ctx, name: string, per: string) =>
			addStock(ctx, {
				operationId: opId(),
				ingredientId: chicken,
				newIngredientName: null,
				quantity: d(per),
				unit: 'g',
				location: '',
				expiresOn: null,
				note: '',
				barcode: {
					gtin: GTIN,
					displayName: name,
					brand: '',
					packageQuantity: d(per),
					packageUnit: 'g',
					packageCount: 1,
					packageLabelText: '',
					origin: 'manual'
				}
			});
		await link(alice.ctx, 'Alice peanut butter', '500');
		await link(bob.ctx, 'Bob peanut butter', '397');

		const [aliceRow] = await db
			.select()
			.from(barcodeLinks)
			.where(and(eq(barcodeLinks.householdId, alice.householdId), eq(barcodeLinks.gtin, GTIN)));
		expect(aliceRow.displayName).toBe('Alice peanut butter');
		expect(Dec.from(aliceRow.defaultQuantity!).toString()).toBe('500');
	});

	it('refuses a write aimed at a household the person does not belong to', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const chicken = await catalogIngredientId('chicken breast');
		await expect(
			addStock(
				{ ...bob.ctx, householdId: alice.householdId },
				{
					operationId: opId(),
					ingredientId: chicken,
					newIngredientName: null,
					quantity: d(500),
					unit: 'g',
					location: '',
					expiresOn: null,
					note: '',
					barcode: {
						gtin: GTIN,
						displayName: 'Sneaky',
						brand: '',
						packageQuantity: d(500),
						packageUnit: 'g',
						packageCount: 1,
						packageLabelText: '',
						origin: 'manual'
					}
				}
			)
		).rejects.toThrow(/member/i);
		expect(await db.select().from(barcodeLinks)).toEqual([]);
	});

	it('shares one link across the members of one household', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
		const bobInAlices = { ...bob.ctx, householdId: alice.householdId };
		const chicken = await catalogIngredientId('chicken breast');
		await addStock(alice.ctx, {
			operationId: opId(),
			ingredientId: chicken,
			newIngredientName: null,
			quantity: d(500),
			unit: 'g',
			location: '',
			expiresOn: null,
			note: '',
			barcode: {
				gtin: GTIN,
				displayName: 'Our peanut butter',
				brand: '',
				packageQuantity: d(500),
				packageUnit: 'g',
				packageCount: 1,
				packageLabelText: '',
				origin: 'manual'
			}
		});
		const usda = stub('usda', () => ({ status: 'missing' }));
		const seen = await lookupBarcode(identity(), bobInAlices.householdId, [usda.adapter]);
		expect(seen.link?.displayName).toBe('Our peanut butter');
	});
});
