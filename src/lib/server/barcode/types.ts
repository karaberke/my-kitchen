import type { Dec } from '$lib/shared/decimal';
import type { BarcodeIdentity } from '$lib/shared/gtin';
import type { BarcodeSource, NutritionBasis } from '$lib/server/db/schema';

export type { BarcodeSource, NutritionBasis };

/**
 * One nutrient exactly as a provider reported it.
 *
 * `value` null means the provider did not state the nutrient. Unknown is not
 * zero, and nothing here is ever inferred from a similar product or name.
 */
export interface ProductNutrient {
	/** USDA nutrient id. Null for a provider that has no such identifier. */
	nutrientId: number | null;
	/** USDA nutrient number ("203"), or the Open Food Facts field key. */
	nutrientNumber: string;
	name: string;
	unit: string;
	value: Dec | null;
	basis: NutritionBasis;
}

/** A product record whose identity a provider adapter has already confirmed. */
export interface ProviderProduct {
	source: BarcodeSource;
	/** Canonical GTIN-14, checked equal to the one that was asked for. */
	gtin: string;
	sourceRef: string;
	sourceVersion: string | null;
	/** YYYY-MM-DD, used to pick between two records deterministically. */
	sourceDate: string | null;
	brand: string;
	name: string;
	packageAmount: Dec | null;
	packageUnit: string | null;
	packageLabelText: string;
	servingAmount: Dec | null;
	servingUnit: string | null;
	servingBasis: NutritionBasis | null;
	nutrients: ProductNutrient[];
}

/**
 * Five answers, kept apart because they mean different things.
 *
 * `missing` is the provider stating that it does not hold this product, and is
 * the only one that may be cached as a miss. `unavailable` and `rate_limited`
 * are temporary and may fall through to the next provider without being
 * recorded. `disabled` means the source was never asked.
 */
export type ProviderResult =
	| { status: 'found'; product: ProviderProduct }
	| { status: 'missing' }
	| { status: 'disabled'; reason: string }
	| { status: 'rate_limited'; retryAfterSeconds: number }
	| { status: 'unavailable'; reason: string };

export type ProviderStatus = ProviderResult['status'];

export interface ProviderAdapter {
	source: BarcodeSource;
	/** True when configuration permits this source to be asked at all. */
	enabled(): boolean;
	/**
	 * The whole identity is passed, not only the canonical GTIN, because each
	 * provider indexes the number in its own shape. Formatting the query is the
	 * adapter's business; deciding equality is not, and is always done on the
	 * canonical GTIN.
	 */
	lookup(identity: BarcodeIdentity, signal: AbortSignal): Promise<ProviderResult>;
}
