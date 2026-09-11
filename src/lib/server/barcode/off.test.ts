import { describe, expect, it } from 'vitest';
import { identifyManual, type BarcodeIdentity } from '$lib/shared/gtin';
import { offAdapter, type OffConfig } from './off';
import type { FetchImpl } from './http';

const identity = (raw: string): BarcodeIdentity => {
	const r = identifyManual(raw);
	if (!r.ok) throw new Error(r.message);
	return r.identity;
};

const CHICKPEAS = identity('4006381333931');

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

const PRODUCT = {
	code: '4006381333931',
	status: 1,
	status_verbose: 'product found',
	product: {
		code: '4006381333931',
		product_name: 'Chickpeas',
		brands: 'Acme, Acme Organics',
		quantity: '400 g (240 g drained)',
		product_quantity: 400,
		product_quantity_unit: 'g',
		serving_quantity: 130,
		rev: 17,
		last_modified_t: 1_700_000_000,
		nutriments: {
			'energy-kcal_100g': 120,
			proteins_100g: 7.6,
			proteins_unit: 'g',
			salt_100g: 0.6
		}
	}
};

const CONFIG: OffConfig = {
	enabled: true,
	baseUrl: 'https://world.openfoodfacts.org',
	contact: 'kitchen@example.test'
};

function adapterFor(body: unknown, status = 200, config: Partial<OffConfig> = {}) {
	const seen: { url: string; init: RequestInit }[] = [];
	const impl: FetchImpl = async (url, init) => {
		seen.push({ url, init });
		return json(body, status);
	};
	return { adapter: offAdapter({ ...CONFIG, ...config }, impl), seen };
}

const run = (a: ReturnType<typeof adapterFor>['adapter'], id = CHICKPEAS) =>
	a.lookup(id, AbortSignal.timeout(5000));

describe('open food facts adapter', () => {
	it('reads a product into the shared shape', async () => {
		const { adapter } = adapterFor(PRODUCT);
		const r = await run(adapter);
		if (r.status !== 'found') throw new Error(`expected found, got ${r.status}`);
		expect(r.product.name).toBe('Chickpeas');
		expect(r.product.brand).toBe('Acme');
		expect(r.product.gtin).toBe('04006381333931');
		expect(r.product.packageAmount?.toString()).toBe('400');
		expect(r.product.packageUnit).toBe('g');
		expect(r.product.packageLabelText).toBe('400 g (240 g drained)');
		expect(r.product.sourceVersion).toBe('17');
		expect(r.product.sourceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('keeps the source so the licence stays attached', async () => {
		const { adapter } = adapterFor(PRODUCT);
		const r = await run(adapter);
		if (r.status !== 'found') throw new Error('expected found');
		expect(r.product.source).toBe('off');
	});

	it('reads nutrients per 100 g, and leaves absent ones absent', async () => {
		const { adapter } = adapterFor(PRODUCT);
		const r = await run(adapter);
		if (r.status !== 'found') throw new Error('expected found');
		const protein = r.product.nutrients.find((n) => n.nutrientNumber === 'proteins');
		expect(protein?.value?.toString()).toBe('7.6');
		expect(protein?.basis).toBe('per_100g');
		expect(r.product.nutrients.find((n) => n.nutrientNumber === 'sugars')).toBeUndefined();
	});

	it('reads a drink per 100 ml', async () => {
		const drink = {
			...PRODUCT,
			product: { ...PRODUCT.product, product_quantity_unit: 'ml', product_quantity: 500 }
		};
		const { adapter } = adapterFor(drink);
		const r = await run(adapter);
		if (r.status !== 'found') throw new Error('expected found');
		expect(r.product.packageUnit).toBe('ml');
		expect(r.product.nutrients[0].basis).toBe('per_100ml');
	});

	it('stores no nutrients when the basis cannot be told', async () => {
		const noUnit = {
			...PRODUCT,
			product: { ...PRODUCT.product, product_quantity_unit: undefined, product_quantity: undefined }
		};
		const { adapter } = adapterFor(noUnit);
		const r = await run(adapter);
		if (r.status !== 'found') throw new Error('expected found');
		expect(r.product.packageAmount).toBeNull();
		expect(r.product.nutrients).toEqual([]);
	});

	it('treats a 404 and a zero status as a confirmed absence', async () => {
		const notFound = adapterFor({ code: '4006381333931', status: 0 }, 404);
		expect((await run(notFound.adapter)).status).toBe('missing');
		const zero = adapterFor({ code: '4006381333931', status: 0, status_verbose: 'no match' });
		expect((await run(zero.adapter)).status).toBe('missing');
	});

	it('refuses an answer about another product', async () => {
		const wrong = {
			...PRODUCT,
			product: { ...PRODUCT.product, code: '0012345678905' }
		};
		const { adapter } = adapterFor(wrong);
		expect((await run(adapter)).status).toBe('unavailable');
	});

	it('separates a throttle and an outage from a missing product', async () => {
		const throttled = adapterFor({}, 429);
		expect((await run(throttled.adapter)).status).toBe('rate_limited');

		const broken = offAdapter(CONFIG, async () => {
			throw new TypeError('connection refused');
		});
		expect((await run(broken)).status).toBe('unavailable');

		const nonsense = adapterFor({ status: 1, product: 'not an object' });
		expect((await run(nonsense.adapter)).status).toBe('unavailable');
	});

	it('is switched off when the install says so', async () => {
		const { adapter, seen } = adapterFor(PRODUCT, 200, { enabled: false });
		expect(adapter.enabled()).toBe(false);
		expect((await run(adapter)).status).toBe('disabled');
		expect(seen).toEqual([]);
	});

	it('identifies itself and asks only for the fields it stores', async () => {
		const { adapter, seen } = adapterFor(PRODUCT);
		await run(adapter);
		const headers = seen[0].init.headers as Record<string, string>;
		expect(headers['user-agent']).toMatch(/^my-kitchen\/[\d.]+ \(kitchen@example\.test\)$/);
		expect(seen[0].url).toContain('/api/v2/product/4006381333931.json');
		expect(seen[0].url).toContain('fields=');
		expect(seen[0].url).not.toContain('images');
	});

	it('uses the documented test credentials against the staging host only', async () => {
		const staging = adapterFor(PRODUCT, 200, { baseUrl: 'https://world.openfoodfacts.net' });
		await run(staging.adapter);
		const stagingHeaders = staging.seen[0].init.headers as Record<string, string>;
		expect(stagingHeaders.authorization).toBe(`Basic ${Buffer.from('off:off').toString('base64')}`);

		const live = adapterFor(PRODUCT);
		await run(live.adapter);
		const liveHeaders = live.seen[0].init.headers as Record<string, string>;
		expect(liveHeaders.authorization).toBeUndefined();
	});
});
