/**
 * USDA FoodData Central.
 *
 * The search endpoint is a text search, not an exact lookup, so every result
 * is filtered by canonical GTIN equality and the first fuzzy name match is
 * never accepted. When two records carry the same GTIN, the newest publication
 * date wins, and the highest fdcId breaks a tie, so the answer does not depend
 * on the order the API happened to return.
 *
 * Nutrient amounts in the Branded Foods dataset are converted by USDA to a
 * 100-unit basis, gram or millilitre, "depending on which was received from
 * the data provider". The unit that decides which of the two it is comes from
 * servingSizeUnit. When that unit is neither a mass nor a volume the basis is
 * unknown, and unknown means the nutrients are not stored at all.
 *
 * USDA data are in the public domain (CC0).
 */

import { z } from 'zod';
import { Dec } from '$lib/shared/decimal';
import { normalizeUnitInput, unitInfo } from '$lib/shared/units';
import { providerGtin, type BarcodeIdentity } from '$lib/shared/gtin';
import { fetchJson, type FetchImpl } from './http';
import type { NutritionBasis, ProductNutrient, ProviderAdapter, ProviderResult } from './types';

const TIMEOUT_MS = 4000;
const MAX_BYTES = 1_000_000;
const PAGE_SIZE = 25;

const nutrientSchema = z.object({
	nutrientId: z.number().optional(),
	nutrientNumber: z.union([z.string(), z.number()]).optional(),
	nutrientName: z.string().optional(),
	unitName: z.string().optional(),
	value: z.number().optional()
});

const foodSchema = z.object({
	fdcId: z.number(),
	description: z.string().optional(),
	dataType: z.string().optional(),
	gtinUpc: z.union([z.string(), z.number()]).optional(),
	brandOwner: z.string().optional(),
	brandName: z.string().optional(),
	publicationDate: z.string().optional(),
	servingSize: z.number().optional(),
	servingSizeUnit: z.string().optional(),
	packageWeight: z.string().optional(),
	foodNutrients: z.array(nutrientSchema).optional()
});

const searchSchema = z.object({
	totalHits: z.number().optional(),
	foods: z.array(foodSchema).optional()
});

type Food = z.infer<typeof foodSchema>;

/** FDC prints either "2019-04-01" or "4/1/2019". Anything else is no date. */
function isoDate(raw: string | undefined): string | null {
	if (!raw) return null;
	const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
	if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
	return null;
}

/** The 100-unit basis USDA converted to, or null when it cannot be told. */
function basisOf(servingSizeUnit: string | undefined): NutritionBasis | null {
	const unit = servingSizeUnit ? normalizeUnitInput(servingSizeUnit) : null;
	const dimension = unitInfo(unit)?.dimension;
	if (dimension === 'mass') return 'per_100g';
	if (dimension === 'volume') return 'per_100ml';
	return null;
}

/** Newest publication date first; the larger fdcId breaks a tie. */
function newest(a: Food, b: Food): number {
	const da = isoDate(a.publicationDate) ?? '';
	const db = isoDate(b.publicationDate) ?? '';
	if (da !== db) return db.localeCompare(da);
	return b.fdcId - a.fdcId;
}

function nutrientsOf(food: Food, basis: NutritionBasis): ProductNutrient[] {
	const out: ProductNutrient[] = [];
	const seen = new Set<string>();
	for (const n of food.foodNutrients ?? []) {
		const number = n.nutrientNumber === undefined ? null : String(n.nutrientNumber).trim();
		if (!number || seen.has(number)) continue;
		if (!n.unitName || !n.nutrientName) continue;
		seen.add(number);
		out.push({
			// The id and the number are different identifiers; both are kept.
			nutrientId: n.nutrientId ?? null,
			nutrientNumber: number,
			name: n.nutrientName,
			unit: n.unitName,
			// A nutrient the panel does not state has no value. It is not zero.
			value: n.value === undefined ? null : Dec.from(n.value),
			basis
		});
	}
	return out;
}

export interface UsdaConfig {
	/** Empty means the source is switched off, not broken. */
	apiKey: string;
	/** A fixed origin. Only the tests point it anywhere but USDA. */
	baseUrl: string;
}

export function usdaAdapter(config: UsdaConfig, fetchImpl?: FetchImpl): ProviderAdapter {
	return {
		source: 'usda',
		enabled: () => config.apiKey !== '',
		async lookup(identity: BarcodeIdentity, signal: AbortSignal): Promise<ProviderResult> {
			const key = config.apiKey;
			if (!key) return { status: 'disabled', reason: 'USDA_API_KEY is not set' };

			// The number as printed is what a manufacturer submitted, so that is
			// what is searched for. Equality is decided afterwards, on the GTIN.
			const url =
				`${config.baseUrl}/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}` +
				`&query=${encodeURIComponent(identity.expanded)}&dataType=Branded&pageSize=${PAGE_SIZE}`;

			const res = await fetchJson(url, {
				timeoutMs: TIMEOUT_MS,
				maxBytes: MAX_BYTES,
				headers: {},
				signal,
				fetchImpl
			});

			if (!res.ok) {
				if (res.kind === 'status' && (res.status === 429 || res.status === 403))
					return { status: 'rate_limited', retryAfterSeconds: res.retryAfterSeconds };
				// The key is in the query string, so nothing about the request is
				// reported back; only the kind of failure.
				return { status: 'unavailable', reason: `USDA ${res.kind}` };
			}

			const parsed = searchSchema.safeParse(res.body);
			if (!parsed.success)
				return { status: 'unavailable', reason: 'USDA sent an unexpected shape' };

			const matches = (parsed.data.foods ?? [])
				.filter((f) => (f.dataType ?? 'Branded') === 'Branded')
				.filter((f) => providerGtin(f.gtinUpc ?? null) === identity.gtin);

			// A text search that returned other products is still a confirmed
			// absence of this one.
			if (matches.length === 0) return { status: 'missing' };

			const food = matches.sort(newest)[0];
			const basis = basisOf(food.servingSizeUnit);
			const servingUnit = food.servingSizeUnit ? normalizeUnitInput(food.servingSizeUnit) : null;

			return {
				status: 'found',
				product: {
					source: 'usda',
					gtin: identity.gtin,
					sourceRef: String(food.fdcId),
					sourceVersion: null,
					sourceDate: isoDate(food.publicationDate),
					brand: (food.brandName || food.brandOwner || '').trim(),
					name: (food.description ?? '').trim(),
					// USDA states net contents as free text, never as a number.
					packageAmount: null,
					packageUnit: null,
					packageLabelText: (food.packageWeight ?? '').trim(),
					servingAmount: food.servingSize === undefined ? null : Dec.from(food.servingSize),
					servingUnit,
					servingBasis: basis,
					nutrients: basis ? nutrientsOf(food, basis) : []
				}
			};
		}
	};
}
