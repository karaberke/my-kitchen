/**
 * Open Food Facts, API v2.
 *
 * v2 answers a barcode directly, so there is no fuzzy matching to guard
 * against, but the code it returns is still checked against the code that was
 * asked for. Only the fields this feature stores are requested.
 *
 * Open Food Facts database data are licensed ODbL, which carries attribution
 * and share-alike duties. `source: 'off'` travels with every cached row and
 * with every household link seeded from one, and is shown in the app. Product
 * images have separate terms and are out of scope, so none are requested.
 *
 * Open Food Facts asks every caller to identify itself and to leave a contact,
 * and limits reads to 15 a minute per IP address. Both are handled here and in
 * the shared provider budget, not per user, because one server has one address.
 */

import { z } from 'zod';
import { Dec } from '$lib/shared/decimal';
import { providerGtin, type BarcodeIdentity } from '$lib/shared/gtin';
import { fetchJson, type FetchImpl } from './http';
import type { NutritionBasis, ProductNutrient, ProviderAdapter, ProviderResult } from './types';

const TIMEOUT_MS = 4000;
const MAX_BYTES = 500_000;

/** Keep in step with package.json; Open Food Facts asks for an app version. */
const APP_VERSION = '0.0.1';

const FIELDS = [
	'code',
	'product_name',
	'brands',
	'quantity',
	'product_quantity',
	'product_quantity_unit',
	'serving_quantity',
	'nutriments',
	'rev',
	'last_modified_t'
].join(',');

/**
 * The nutrients stored, with the identifier and name used for each. Open Food
 * Facts has no numeric nutrient id, so the field key is the identifier.
 */
const NUTRIENTS: readonly { key: string; name: string; unit: string }[] = [
	{ key: 'energy-kcal', name: 'Energy', unit: 'kcal' },
	{ key: 'fat', name: 'Total fat', unit: 'g' },
	{ key: 'saturated-fat', name: 'Saturated fat', unit: 'g' },
	{ key: 'carbohydrates', name: 'Carbohydrate', unit: 'g' },
	{ key: 'sugars', name: 'Sugars', unit: 'g' },
	{ key: 'fiber', name: 'Fibre', unit: 'g' },
	{ key: 'proteins', name: 'Protein', unit: 'g' },
	{ key: 'salt', name: 'Salt', unit: 'g' },
	{ key: 'sodium', name: 'Sodium', unit: 'g' }
];

const productSchema = z.object({
	code: z.union([z.string(), z.number()]).optional(),
	product_name: z.string().optional(),
	brands: z.string().optional(),
	quantity: z.string().optional(),
	product_quantity: z.union([z.string(), z.number()]).optional(),
	product_quantity_unit: z.string().optional(),
	serving_quantity: z.union([z.string(), z.number()]).optional(),
	nutriments: z.record(z.string(), z.unknown()).optional(),
	rev: z.number().optional(),
	last_modified_t: z.number().optional()
});

const envelopeSchema = z.object({
	code: z.union([z.string(), z.number()]).optional(),
	status: z.union([z.number(), z.string()]).optional(),
	status_verbose: z.string().optional(),
	product: productSchema.optional()
});

function numberOf(value: string | number | undefined): Dec | null {
	if (value === undefined || value === '') return null;
	try {
		const dec = Dec.from(typeof value === 'number' ? value : value.trim().replace(',', '.'));
		return dec.isPositive() ? dec : null;
	} catch {
		return null;
	}
}

/** Unix seconds to a calendar date. */
function isoDate(seconds: number | undefined): string | null {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
	return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * The "_100g" fields hold a value per 100 g or per 100 ml, and the product's
 * own unit is what says which. When there is no unit the basis is unknown, and
 * unknown nutrients are not stored.
 */
function basisOf(unit: string | undefined): NutritionBasis | null {
	const clean = (unit ?? '').trim().toLowerCase();
	if (clean === 'g') return 'per_100g';
	if (clean === 'ml' || clean === 'l') return 'per_100ml';
	return null;
}

function nutrientsOf(
	nutriments: Record<string, unknown> | undefined,
	basis: NutritionBasis
): ProductNutrient[] {
	if (!nutriments) return [];
	const out: ProductNutrient[] = [];
	for (const { key, name, unit } of NUTRIENTS) {
		const raw = nutriments[`${key}_100g`];
		// A nutrient Open Food Facts does not hold stays absent, not zero.
		if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
		const reported = nutriments[`${key}_unit`];
		out.push({
			nutrientId: null,
			nutrientNumber: key,
			name,
			unit: typeof reported === 'string' && reported.trim() ? reported.trim() : unit,
			value: Dec.from(raw),
			basis
		});
	}
	return out;
}

export interface OffConfig {
	enabled: boolean;
	/** A fixed https origin. Point it at the staging host to work offline of production. */
	baseUrl: string;
	/** Whatever identifies this install to Open Food Facts. */
	contact: string;
}

export function offAdapter(config: OffConfig, fetchImpl?: FetchImpl): ProviderAdapter {
	return {
		source: 'off',
		enabled: () => config.enabled,
		async lookup(identity: BarcodeIdentity, signal: AbortSignal): Promise<ProviderResult> {
			if (!config.enabled) return { status: 'disabled', reason: 'OFF_ENABLED is false' };

			const contact = config.contact || 'self-hosted';
			const headers: Record<string, string> = {
				'user-agent': `my-kitchen/${APP_VERSION} (${contact})`
			};
			// The documented staging host is protected by a fixed test password.
			if (new URL(config.baseUrl).hostname.endsWith('.net'))
				headers.authorization = `Basic ${Buffer.from('off:off').toString('base64')}`;

			const url =
				`${config.baseUrl}/api/v2/product/${encodeURIComponent(identity.expanded)}.json` +
				`?fields=${encodeURIComponent(FIELDS)}`;

			const res = await fetchJson(url, {
				timeoutMs: TIMEOUT_MS,
				maxBytes: MAX_BYTES,
				headers,
				signal,
				fetchImpl
			});

			if (!res.ok) {
				if (res.kind === 'status' && (res.status === 429 || res.status === 403))
					return { status: 'rate_limited', retryAfterSeconds: res.retryAfterSeconds };
				return { status: 'unavailable', reason: `Open Food Facts ${res.kind}` };
			}

			const parsed = envelopeSchema.safeParse(res.body);
			if (!parsed.success)
				return { status: 'unavailable', reason: 'Open Food Facts sent an unexpected shape' };

			const envelope = parsed.data;
			const found = Number(envelope.status) === 1 && res.status !== 404;
			if (!found || !envelope.product) return { status: 'missing' };

			const product = envelope.product;
			// v2 answers the code it was given, so a different one is not an answer.
			if (providerGtin(product.code ?? envelope.code ?? null) !== identity.gtin)
				return { status: 'unavailable', reason: 'Open Food Facts answered about another product' };

			const name = (product.product_name ?? '').trim();
			if (!name) return { status: 'missing' };

			const packageUnit = basisOf(product.product_quantity_unit) === 'per_100ml' ? 'ml' : 'g';
			const packageAmount = product.product_quantity_unit
				? numberOf(product.product_quantity)
				: null;
			const basis = basisOf(product.product_quantity_unit);

			return {
				status: 'found',
				product: {
					source: 'off',
					gtin: identity.gtin,
					sourceRef: String(product.code ?? identity.expanded),
					sourceVersion: product.rev === undefined ? null : String(product.rev),
					sourceDate: isoDate(product.last_modified_t),
					brand: (product.brands ?? '').split(',')[0].trim(),
					name,
					packageAmount,
					packageUnit: packageAmount ? packageUnit : null,
					packageLabelText: (product.quantity ?? '').trim(),
					servingAmount: numberOf(product.serving_quantity),
					servingUnit: product.serving_quantity ? packageUnit : null,
					servingBasis: basis,
					nutrients: basis ? nutrientsOf(product.nutriments, basis) : []
				}
			};
		}
	};
}
