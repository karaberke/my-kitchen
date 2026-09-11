import { describe, expect, it } from 'vitest';
import { identifyManual, type BarcodeIdentity } from '$lib/shared/gtin';
import { usdaAdapter } from './usda';
import type { FetchImpl } from './http';

const identity = (raw: string): BarcodeIdentity => {
	const r = identifyManual(raw);
	if (!r.ok) throw new Error(r.message);
	return r.identity;
};

const PEANUT_BUTTER = identity('012345678905');

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

/** Two records for the asked-for product, plus one that only looks similar. */
const SEARCH_BODY = {
	totalHits: 3,
	foods: [
		{
			fdcId: 111,
			description: 'CREAMY PEANUT BUTTER',
			dataType: 'Branded',
			gtinUpc: '012345678912',
			brandName: 'Someone Else',
			publicationDate: '1/1/2025'
		},
		{
			fdcId: 222,
			description: 'CREAMY PEANUT BUTTER',
			dataType: 'Branded',
			gtinUpc: '012345678905',
			brandOwner: 'Acme Foods',
			publicationDate: '4/1/2019',
			servingSize: 32,
			servingSizeUnit: 'g',
			packageWeight: '16 oz/453 g',
			foodNutrients: [
				{
					nutrientId: 1003,
					nutrientNumber: '203',
					nutrientName: 'Protein',
					unitName: 'G',
					value: 25
				}
			]
		},
		{
			fdcId: 333,
			description: 'CREAMY PEANUT BUTTER',
			dataType: 'Branded',
			// the same product, printed with the leading zero of an EAN-13
			gtinUpc: '0012345678905',
			brandName: 'Acme',
			publicationDate: '2023-06-15',
			servingSize: 32,
			servingSizeUnit: 'g',
			packageWeight: '16 oz/453 g',
			foodNutrients: [
				{
					nutrientId: 1003,
					nutrientNumber: '203',
					nutrientName: 'Protein',
					unitName: 'G',
					value: 26
				},
				{ nutrientId: 1005, nutrientNumber: '205', nutrientName: 'Carbohydrate', unitName: 'G' }
			]
		}
	]
};

function adapterFor(body: unknown, status = 200, key = 'test-key') {
	const calls: string[] = [];
	const impl: FetchImpl = async (url) => {
		calls.push(url);
		return json(body, status);
	};
	return {
		adapter: usdaAdapter({ apiKey: key, baseUrl: 'https://api.nal.usda.gov' }, impl),
		calls
	};
}

const run = (a: ReturnType<typeof adapterFor>['adapter'], id = PEANUT_BUTTER) =>
	a.lookup(id, AbortSignal.timeout(5000));

describe('usda adapter', () => {
	it('is switched off, not broken, without a key', async () => {
		const { adapter, calls } = adapterFor(SEARCH_BODY, 200, '');
		expect(adapter.enabled()).toBe(false);
		const r = await run(adapter);
		expect(r.status).toBe('disabled');
		expect(calls).toEqual([]);
	});

	it('keeps only records whose GTIN matches, whatever the name says', async () => {
		const { adapter } = adapterFor(SEARCH_BODY);
		const r = await run(adapter);
		if (r.status !== 'found') throw new Error(`expected found, got ${r.status}`);
		expect(r.product.gtin).toBe('00012345678905');
		expect(r.product.sourceRef).not.toBe('111');
	});

	it('picks the newest record deterministically, not the first returned', async () => {
		const { adapter } = adapterFor(SEARCH_BODY);
		const r = await run(adapter);
		if (r.status !== 'found') throw new Error('expected found');
		expect(r.product.sourceRef).toBe('333');
		expect(r.product.sourceDate).toBe('2023-06-15');
	});

	it('never accepts a fuzzy name match', async () => {
		const onlySimilar = { totalHits: 1, foods: [SEARCH_BODY.foods[0]] };
		const { adapter } = adapterFor(onlySimilar);
		expect((await run(adapter)).status).toBe('missing');
	});

	it('treats an empty result as a confirmed absence', async () => {
		const { adapter } = adapterFor({ totalHits: 0, foods: [] });
		expect((await run(adapter)).status).toBe('missing');
	});

	it('keeps nutrient ids and nutrient numbers apart, and unknown out of zero', async () => {
		const { adapter } = adapterFor(SEARCH_BODY);
		const r = await run(adapter);
		if (r.status !== 'found') throw new Error('expected found');
		const protein = r.product.nutrients.find((n) => n.nutrientNumber === '203');
		expect(protein?.nutrientId).toBe(1003);
		expect(protein?.value?.toString()).toBe('26');
		expect(protein?.basis).toBe('per_100g');
		const carbohydrate = r.product.nutrients.find((n) => n.nutrientNumber === '205');
		expect(carbohydrate?.value).toBeNull();
	});

	it('reads the 100-unit basis from the serving unit', async () => {
		const liquid = {
			foods: [{ ...SEARCH_BODY.foods[2], servingSizeUnit: 'ml' }]
		};
		const { adapter } = adapterFor(liquid);
		const r = await run(adapter);
		if (r.status !== 'found') throw new Error('expected found');
		expect(r.product.servingBasis).toBe('per_100ml');
		expect(r.product.nutrients[0].basis).toBe('per_100ml');
	});

	it('stores no nutrients when the basis cannot be told', async () => {
		const noUnit = { foods: [{ ...SEARCH_BODY.foods[2], servingSizeUnit: undefined }] };
		const { adapter } = adapterFor(noUnit);
		const r = await run(adapter);
		if (r.status !== 'found') throw new Error('expected found');
		expect(r.product.servingBasis).toBeNull();
		expect(r.product.nutrients).toEqual([]);
	});

	it('keeps the net-contents text for the confirmation screen', async () => {
		const { adapter } = adapterFor(SEARCH_BODY);
		const r = await run(adapter);
		if (r.status !== 'found') throw new Error('expected found');
		expect(r.product.packageLabelText).toBe('16 oz/453 g');
		expect(r.product.packageAmount).toBeNull();
	});

	it('separates a throttle and an outage from a missing product', async () => {
		const throttled = adapterFor({}, 429);
		const r1 = await run(throttled.adapter);
		expect(r1.status).toBe('rate_limited');

		const broken = usdaAdapter(
			{ apiKey: 'test-key', baseUrl: 'https://api.nal.usda.gov' },
			async () => {
				throw new TypeError('connection refused');
			}
		);
		const r2 = await run(broken);
		expect(r2.status).toBe('unavailable');

		const nonsense = adapterFor({ foods: 'not an array' });
		expect((await run(nonsense.adapter)).status).toBe('unavailable');
	});

	it('never puts the key in a message it hands back', async () => {
		const secret = 'super-secret-key';
		const broken = usdaAdapter(
			{ apiKey: secret, baseUrl: 'https://api.nal.usda.gov' },
			async () => {
				throw new TypeError('connection refused');
			}
		);
		const r = await run(broken);
		if (r.status !== 'unavailable') throw new Error('expected unavailable');
		expect(r.reason).not.toContain(secret);
	});

	it('asks the provider for the number as printed', async () => {
		const { adapter, calls } = adapterFor(SEARCH_BODY);
		await run(adapter);
		expect(calls[0]).toContain('query=012345678905');
		expect(calls[0]).toContain('dataType=Branded');
	});
});
