/**
 * Package arithmetic for scanned products.
 *
 * Four amounts are kept apart and never substituted for one another:
 *
 *   package amount   what one package holds, e.g. 500 g
 *   package count    how many of those packages are being added, e.g. 2
 *   serving size     what the nutrition panel is measured against
 *   pantry amount    package amount x package count, the number that is stored
 *
 * A serving size is never used as a package size. When no package size is
 * known the suggestion is `null`, which the confirmation screen must turn into
 * a quantity the user types before anything can be saved.
 *
 * Label text is parsed conservatively and only ever produces an editable
 * suggestion. Anything unclear returns unknown instead of a guess. The
 * original label text is preserved whether it was understood or not.
 */

import { Dec } from './decimal';
import { convertAmount, normalizeUnitInput, unitInfo } from './units';

/**
 * Units a net-contents statement actually uses. Spoons and cups are recipe
 * units, and package units (bag, can, box) would only restate the packaging.
 */
export const PACKAGE_SIZE_UNITS: readonly string[] = [
	'g',
	'kg',
	'mg',
	'oz',
	'lb',
	'ml',
	'l',
	'fl_oz',
	'piece'
];

/**
 * US retail is the market these stores sell in, so a fluid ounce is the US
 * one. The difference from the metric reading is 1.4 %, well inside the
 * agreement tolerance below, so this choice cannot change whether two printed
 * amounts are accepted as the same quantity.
 */
const CONVENTION = 'us';

/** How far two printed statements of one quantity may differ, as label rounding. */
const TOLERANCE_PERCENT = 2;

const MAX_PACKAGE_COUNT = 999;

export interface PackageSize {
	amount: Dec;
	/** A unit id from PACKAGE_SIZE_UNITS. */
	unit: string;
}

export type PackageSizeReason = 'absent' | 'unparsed' | 'unsupported_unit' | 'conflicting_amounts';

export interface PackageSizeSuggestion {
	/** null means unknown. Unknown is never zero. */
	size: PackageSize | null;
	/**
	 * Packages the label itself describes, from a "12 x 330 ml" statement.
	 * 1 when the label describes one package. The confirmation screen uses it
	 * as the starting package count, and the user may change it.
	 */
	packagesInLabel: number;
	source: 'structured' | 'label_text' | 'unknown';
	/** Exactly what the provider printed, kept even when nothing was understood. */
	labelText: string;
	reason?: PackageSizeReason;
}

function unknown(labelText: string, reason: PackageSizeReason): PackageSizeSuggestion {
	return { size: null, packagesInLabel: 1, source: 'unknown', labelText, reason };
}

function isSupported(unit: string | null): unit is string {
	return !!unit && PACKAGE_SIZE_UNITS.includes(unit);
}

/** Every "number unit" pair in the text, in the order printed. */
function amountsIn(text: string): PackageSize[] {
	const out: PackageSize[] = [];
	const re = /(\d+(?:[.,]\d+)?)\s*(fl\.?\s*oz\.?|fluid\s+ounces?|[a-z]+\.?)/gi;
	for (const m of text.matchAll(re)) {
		const unit = normalizeUnitInput(m[2]);
		if (!isSupported(unit)) continue;
		let amount: Dec;
		try {
			amount = Dec.from(m[1].replace(',', '.'));
		} catch {
			continue;
		}
		if (!amount.isPositive()) continue;
		out.push({ amount, unit });
	}
	return out;
}

/** True when two printed amounts are the same quantity, within label rounding. */
function agree(a: PackageSize, b: PackageSize): boolean {
	const converted = convertAmount(b.amount, b.unit, a.unit, CONVENTION);
	if (!converted) return false;
	const difference = converted.sub(a.amount).abs();
	return difference.mulRatio(100, 1).lte(a.amount.mulRatio(TOLERANCE_PERCENT, 1));
}

function parseSingle(text: string, labelText: string): PackageSizeSuggestion {
	const found = amountsIn(text);
	if (found.length === 0) {
		// Distinguish "no unit we support" from "nothing that looks like an amount".
		const hadNumber = /\d/.test(text);
		return unknown(labelText, hadNumber ? 'unsupported_unit' : 'unparsed');
	}
	const first = found[0];
	// "9.5 oz (269 g)" states one quantity twice. "1 lb 8 oz" states two, and
	// adding them would be a guess, so it stays unknown.
	for (const other of found.slice(1)) {
		if (!agree(first, other)) return unknown(labelText, 'conflicting_amounts');
	}
	return { size: first, packagesInLabel: 1, source: 'label_text', labelText };
}

/**
 * Read a net-contents statement such as "397 g", "1.5 L", "16 fl oz" or
 * "12 x 330 ml" into an editable suggestion.
 */
export function parsePackageSizeText(raw: string): PackageSizeSuggestion {
	const labelText = raw.trim();
	if (!labelText) return unknown(labelText, 'absent');
	const text = labelText.replace(/\s+/g, ' ');

	// A multipack is read before units are matched, because "x" is also an
	// alias for a countable piece.
	const leading = /^(\d{1,3})\s*[x×]\s*(.+)$/i.exec(text);
	const trailing = /^(.+?)\s*[x×]\s*(\d{1,3})$/i.exec(text);
	const multipack = leading
		? { count: Number(leading[1]), rest: leading[2] }
		: trailing
			? { count: Number(trailing[2]), rest: trailing[1] }
			: null;
	if (multipack && multipack.count >= 1 && multipack.count <= MAX_PACKAGE_COUNT) {
		const inner = parseSingle(multipack.rest, labelText);
		if (!inner.size) return unknown(labelText, inner.reason ?? 'unparsed');
		return { ...inner, packagesInLabel: multipack.count };
	}

	return parseSingle(text, labelText);
}

/**
 * The package size to offer, preferring a provider's structured fields and
 * falling back to its label text. The label text is carried either way.
 */
export function packageSizeSuggestion(
	structured: { amount: Dec | null; unit: string | null } | null,
	labelText: string
): PackageSizeSuggestion {
	const unit = structured?.unit ? normalizeUnitInput(structured.unit) : null;
	if (structured?.amount && structured.amount.isPositive() && isSupported(unit)) {
		return {
			size: { amount: structured.amount, unit },
			packagesInLabel: 1,
			source: 'structured',
			labelText: labelText.trim()
		};
	}
	return parsePackageSizeText(labelText);
}

export type PantryAmount = { ok: true; quantity: Dec; unit: string } | { ok: false; error: string };

/**
 * The amount that reaches the pantry: package amount x package count.
 * Two confirmed 500 g bags are 1000 g, in one lot.
 */
export function pantryAmount(size: PackageSize, packageCount: number): PantryAmount {
	if (!Number.isInteger(packageCount) || packageCount < 1 || packageCount > MAX_PACKAGE_COUNT)
		return { ok: false, error: `Enter how many packages, 1 to ${MAX_PACKAGE_COUNT}.` };
	if (!unitInfo(size.unit)) return { ok: false, error: 'Unknown unit' };
	if (!size.amount.isPositive()) return { ok: false, error: 'Enter what one package holds.' };
	return {
		ok: true,
		quantity: size.amount.mulRatio(packageCount, 1),
		unit: size.unit
	};
}
