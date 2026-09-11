/**
 * Resolve a barcode into something the confirmation screen can show.
 *
 * Order of enquiry, and nothing is skipped:
 *   1. what this household already confirmed  (personal, never expires)
 *   2. provider metadata still inside its TTL (shared, no network)
 *   3. a confirmed miss still inside its TTL  (shared, no network)
 *   4. the enabled providers, in order, inside one budget
 *
 * A lookup never changes inventory and never writes a household's own values.
 * It may write provider metadata and confirmed misses, which are shared and
 * disposable.
 */

import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	barcodeLinks,
	barcodeMisses,
	barcodeProductNutrients,
	barcodeProducts,
	ingredients
} from '$lib/server/db/schema';
import { consume, PROVIDER_LIMITS } from '$lib/server/ratelimit';
import { serverEnv } from '$lib/server/env';
import { withTransaction } from '$lib/server/operations';
import { Dec } from '$lib/shared/decimal';
import type { BarcodeIdentity } from '$lib/shared/gtin';
import { usdaAdapter } from './usda';
import { offAdapter } from './off';
import type {
	BarcodeSource,
	ProviderAdapter,
	ProviderProduct,
	ProviderResult,
	ProviderStatus
} from './types';

/** Provider metadata is refreshed after this long. */
export const PRODUCT_TTL_DAYS = 30;
/** A confirmed "not in my database" is asked again after this long. */
export const MISS_TTL_HOURS = 24;
/** The whole lookup, however many providers it asks. */
export const TOTAL_BUDGET_MS = 6000;

/** USDA first: it is CC0, and it covers the US stores this install shops at. */
const ORDER: readonly BarcodeSource[] = ['usda', 'off'];

export interface ProductView {
	source: BarcodeSource;
	sourceRef: string;
	sourceVersion: string | null;
	sourceDate: string | null;
	retrievedAt: string;
	brand: string;
	name: string;
	packageAmount: string | null;
	packageUnit: string | null;
	packageLabelText: string;
	servingAmount: string | null;
	servingUnit: string | null;
}

export interface LinkView {
	ingredientId: string;
	ingredientName: string;
	displayName: string;
	brand: string;
	defaultQuantity: string | null;
	defaultUnit: string | null;
	defaultPackageCount: number;
	packageLabelText: string;
	origin: string;
	updatedAt: string;
}

export interface SourceReport {
	source: BarcodeSource;
	/** 'not_asked' means an earlier source had already answered. */
	status: ProviderStatus | 'not_asked';
	/** True when the answer came from the cache rather than the network. */
	cached: boolean;
}

export interface BarcodeLookup {
	gtin: string;
	symbology: BarcodeIdentity['symbology'];
	digits: string;
	/** What this household confirmed before, if anything. */
	link: LinkView | null;
	/** The provider record to show beside it, if any. */
	product: ProductView | null;
	sources: SourceReport[];
	/**
	 * known         this household has confirmed this barcode before
	 * found         a provider holds it
	 * not_found     every enabled provider said it does not hold it
	 * unavailable   nothing found, and at least one provider could not answer
	 * no_providers  nothing found, and no provider was enabled
	 */
	outcome: 'known' | 'found' | 'not_found' | 'unavailable' | 'no_providers';
}

/**
 * The configured adapters, in the order they are asked.
 *
 * Reading the environment happens here and nowhere else, so an adapter is a
 * plain function of its configuration and can be tested without one.
 */
export function configuredAdapters(): ProviderAdapter[] {
	const env = serverEnv();
	const byName: Record<BarcodeSource, ProviderAdapter> = {
		usda: usdaAdapter({ apiKey: env.USDA_API_KEY, baseUrl: env.USDA_BASE_URL }),
		off: offAdapter({
			enabled: env.OFF_ENABLED,
			baseUrl: env.OFF_BASE_URL,
			contact: env.OFF_CONTACT || env.ORIGIN
		})
	};
	return ORDER.map((s) => byName[s]);
}

/* -------------------------------------------------------------------- */
/* Cache reads and writes                                                */
/* -------------------------------------------------------------------- */

function productView(row: typeof barcodeProducts.$inferSelect): ProductView {
	return {
		source: row.source,
		sourceRef: row.sourceRef,
		sourceVersion: row.sourceVersion,
		sourceDate: row.sourceDate,
		retrievedAt: row.retrievedAt,
		brand: row.brand,
		name: row.name,
		packageAmount: row.packageAmount === null ? null : Dec.from(row.packageAmount).toString(),
		packageUnit: row.packageUnit,
		packageLabelText: row.packageLabelText,
		servingAmount: row.servingAmount === null ? null : Dec.from(row.servingAmount).toString(),
		servingUnit: row.servingUnit
	};
}

/** The same view for a record that has just arrived and not been re-read. */
function liveView(p: ProviderProduct): ProductView {
	return {
		source: p.source,
		sourceRef: p.sourceRef,
		sourceVersion: p.sourceVersion,
		sourceDate: p.sourceDate,
		retrievedAt: new Date().toISOString(),
		brand: p.brand,
		name: p.name,
		packageAmount: p.packageAmount?.toString() ?? null,
		packageUnit: p.packageUnit,
		packageLabelText: p.packageLabelText,
		servingAmount: p.servingAmount?.toString() ?? null,
		servingUnit: p.servingUnit
	};
}

async function freshProducts(gtin: string) {
	return db
		.select()
		.from(barcodeProducts)
		.where(and(eq(barcodeProducts.gtin, gtin), gt(barcodeProducts.expiresAt, sql`now()`)));
}

async function freshMisses(gtin: string): Promise<Set<BarcodeSource>> {
	const rows = await db
		.select({ source: barcodeMisses.source })
		.from(barcodeMisses)
		.where(and(eq(barcodeMisses.gtin, gtin), gt(barcodeMisses.expiresAt, sql`now()`)));
	return new Set(rows.map((r) => r.source));
}

/** Store a product and its nutrients, replacing any earlier record of it. */
async function storeProduct(product: ProviderProduct): Promise<void> {
	await withTransaction(async (tx) => {
		const [row] = await tx
			.insert(barcodeProducts)
			.values({
				gtin: product.gtin,
				source: product.source,
				sourceRef: product.sourceRef,
				sourceVersion: product.sourceVersion,
				sourceDate: product.sourceDate,
				brand: product.brand,
				name: product.name,
				packageAmount: product.packageAmount?.toDb() ?? null,
				packageUnit: product.packageUnit,
				packageLabelText: product.packageLabelText,
				servingAmount: product.servingAmount?.toDb() ?? null,
				servingUnit: product.servingUnit,
				servingBasis: product.servingBasis,
				retrievedAt: sql`now()`,
				expiresAt: sql`now() + make_interval(days => ${PRODUCT_TTL_DAYS})`
			})
			.onConflictDoUpdate({
				target: [barcodeProducts.gtin, barcodeProducts.source],
				set: {
					sourceRef: product.sourceRef,
					sourceVersion: product.sourceVersion,
					sourceDate: product.sourceDate,
					brand: product.brand,
					name: product.name,
					packageAmount: product.packageAmount?.toDb() ?? null,
					packageUnit: product.packageUnit,
					packageLabelText: product.packageLabelText,
					servingAmount: product.servingAmount?.toDb() ?? null,
					servingUnit: product.servingUnit,
					servingBasis: product.servingBasis,
					retrievedAt: sql`now()`,
					expiresAt: sql`now() + make_interval(days => ${PRODUCT_TTL_DAYS})`
				}
			})
			.returning({ id: barcodeProducts.id });

		await tx.delete(barcodeProductNutrients).where(eq(barcodeProductNutrients.productId, row.id));
		if (product.nutrients.length)
			await tx.insert(barcodeProductNutrients).values(
				product.nutrients.map((n) => ({
					productId: row.id,
					nutrientId: n.nutrientId,
					nutrientNumber: n.nutrientNumber,
					name: n.name,
					unit: n.unit,
					value: n.value?.toDb() ?? null,
					basis: n.basis
				}))
			);

		// A source that now holds the product cannot also be missing it.
		await tx
			.delete(barcodeMisses)
			.where(and(eq(barcodeMisses.gtin, product.gtin), eq(barcodeMisses.source, product.source)));
	});
}

/** Record that one source confirmed it does not hold this product. */
async function storeMiss(gtin: string, source: BarcodeSource): Promise<void> {
	await withTransaction(async (tx) => {
		await tx
			.insert(barcodeMisses)
			.values({
				gtin,
				source,
				confirmedAt: sql`now()`,
				expiresAt: sql`now() + make_interval(hours => ${MISS_TTL_HOURS})`
			})
			.onConflictDoUpdate({
				target: [barcodeMisses.gtin, barcodeMisses.source],
				set: {
					confirmedAt: sql`now()`,
					expiresAt: sql`now() + make_interval(hours => ${MISS_TTL_HOURS})`
				}
			});
		await tx
			.delete(barcodeProducts)
			.where(and(eq(barcodeProducts.gtin, gtin), eq(barcodeProducts.source, source)));
	});
}

/** Drop provider rows nobody can use any more. Household links are untouched. */
export async function cleanupBarcodeCache(): Promise<number> {
	const products = await db
		.delete(barcodeProducts)
		.where(sql`${barcodeProducts.expiresAt} < now() - interval '7 days'`)
		.returning({ id: barcodeProducts.id });
	const misses = await db
		.delete(barcodeMisses)
		.where(sql`${barcodeMisses.expiresAt} < now() - interval '7 days'`)
		.returning({ gtin: barcodeMisses.gtin });
	return products.length + misses.length;
}

/* -------------------------------------------------------------------- */
/* Providers                                                             */
/* -------------------------------------------------------------------- */

/**
 * One network call per barcode per source at a time.
 *
 * Two people scanning the same case of soda, or one phone retrying, must not
 * become two requests to a provider that counts them against one address.
 */
const inFlight = new Map<string, Promise<ProviderResult>>();

async function askProvider(
	adapter: ProviderAdapter,
	identity: BarcodeIdentity,
	signal: AbortSignal
): Promise<ProviderResult> {
	const key = `${adapter.source}:${identity.gtin}`;
	const running = inFlight.get(key);
	if (running) return running;

	const budget = consume(`provider:${adapter.source}`, PROVIDER_LIMITS[adapter.source]);
	if (!budget.allowed)
		return { status: 'rate_limited', retryAfterSeconds: budget.retryAfterSeconds };

	const attempt = (async () => {
		try {
			return await adapter.lookup(identity, signal);
		} catch {
			return { status: 'unavailable', reason: `${adapter.source} threw` } as ProviderResult;
		} finally {
			inFlight.delete(key);
		}
	})();
	inFlight.set(key, attempt);
	return attempt;
}

/* -------------------------------------------------------------------- */
/* The lookup                                                            */
/* -------------------------------------------------------------------- */

async function householdLink(householdId: string, gtin: string): Promise<LinkView | null> {
	const [row] = await db
		.select({
			ingredientId: barcodeLinks.ingredientId,
			ingredientName: ingredients.name,
			displayName: barcodeLinks.displayName,
			brand: barcodeLinks.brand,
			defaultQuantity: barcodeLinks.defaultQuantity,
			defaultUnit: barcodeLinks.defaultUnit,
			defaultPackageCount: barcodeLinks.defaultPackageCount,
			packageLabelText: barcodeLinks.packageLabelText,
			origin: barcodeLinks.origin,
			updatedAt: barcodeLinks.updatedAt
		})
		.from(barcodeLinks)
		.innerJoin(ingredients, eq(ingredients.id, barcodeLinks.ingredientId))
		.where(and(eq(barcodeLinks.householdId, householdId), eq(barcodeLinks.gtin, gtin)))
		.limit(1);
	if (!row) return null;
	return {
		...row,
		defaultQuantity: row.defaultQuantity === null ? null : Dec.from(row.defaultQuantity).toString()
	};
}

export async function lookupBarcode(
	identity: BarcodeIdentity,
	householdId: string,
	/** Test seam. Production passes nothing and gets the configured adapters. */
	providers?: ProviderAdapter[]
): Promise<BarcodeLookup> {
	const gtin = identity.gtin;
	const base = {
		gtin,
		symbology: identity.symbology,
		digits: identity.digits
	};

	const [link, cachedRows, missed] = await Promise.all([
		householdLink(householdId, gtin),
		freshProducts(gtin),
		freshMisses(gtin)
	]);

	const cached = new Map(cachedRows.map((r) => [r.source, r]));
	const fetched = new Map<BarcodeSource, ProviderProduct>();
	const reports: SourceReport[] = [];
	const budget = AbortSignal.timeout(TOTAL_BUDGET_MS);

	const answered = () => ORDER.some((s) => fetched.has(s) || cached.has(s));

	for (const adapter of providers ?? configuredAdapters()) {
		const source = adapter.source;
		if (!adapter.enabled()) {
			reports.push({ source, status: 'disabled', cached: false });
			continue;
		}
		if (cached.has(source)) {
			reports.push({ source, status: 'found', cached: true });
			continue;
		}
		if (missed.has(source)) {
			reports.push({ source, status: 'missing', cached: true });
			continue;
		}
		// One product needs one answer. Asking a second database once the first
		// has answered spends an allowance that every household here shares.
		if (answered()) {
			reports.push({ source, status: 'not_asked', cached: false });
			continue;
		}
		if (budget.aborted) {
			reports.push({ source, status: 'unavailable', cached: false });
			continue;
		}

		const answer = await askProvider(adapter, identity, budget);
		reports.push({ source, status: answer.status, cached: false });
		if (answer.status === 'found') {
			await storeProduct(answer.product);
			fetched.set(source, answer.product);
		} else if (answer.status === 'missing') {
			// Only a stated absence is remembered. A timeout or a throttle is not
			// evidence about the product, so nothing is written.
			await storeMiss(gtin, source);
		}
	}

	// USDA before Open Food Facts, matching the order they were asked in. A
	// record just fetched is preferred over the same source's cached row.
	const product =
		ORDER.map((s) => {
			const live = fetched.get(s);
			if (live) return liveView(live);
			const row = cached.get(s);
			return row ? productView(row) : null;
		}).find((v) => v !== null) ?? null;

	const enabled = reports.filter((r) => r.status !== 'disabled' && r.status !== 'not_asked');
	const outcome: BarcodeLookup['outcome'] = link
		? 'known'
		: product
			? 'found'
			: enabled.length === 0
				? 'no_providers'
				: enabled.every((r) => r.status === 'missing')
					? 'not_found'
					: 'unavailable';

	return { ...base, link, product, sources: reports, outcome };
}

/** Test hook: forget which requests are in flight. */
export function resetBarcodeInFlight(): void {
	inFlight.clear();
}

/** Every ingredient id a household has already linked to a barcode. */
export async function linkedIngredientIds(
	householdId: string,
	gtins: string[]
): Promise<Map<string, string>> {
	if (!gtins.length) return new Map();
	const rows = await db
		.select({ gtin: barcodeLinks.gtin, ingredientId: barcodeLinks.ingredientId })
		.from(barcodeLinks)
		.where(and(eq(barcodeLinks.householdId, householdId), inArray(barcodeLinks.gtin, gtins)));
	return new Map(rows.map((r) => [r.gtin, r.ingredientId]));
}
