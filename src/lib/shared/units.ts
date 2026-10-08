import { Dec } from './decimal';

export type Dimension = 'mass' | 'volume' | 'count' | 'package';
export type Convention = 'metric' | 'us';

export interface UnitDef {
	id: string;
	dimension: Dimension;
	singular: string;
	plural: string;
	aliases: string[];
	/** Factor to the dimension base (g, ml, piece) per convention. Absent for package units. */
	toBase?: { metric: string; us: string };
}

/**
 * Immutable unit definitions shared by the browser and the server.
 * Mass base is grams, volume base is millilitres, count base is piece.
 * Package units (can, bag, clove ...) have no known size; they only ever
 * match themselves and never convert.
 */
export const UNITS: readonly UnitDef[] = [
	{
		id: 'g',
		dimension: 'mass',
		singular: 'g',
		plural: 'g',
		aliases: ['gram', 'grams', 'gr'],
		toBase: { metric: '1', us: '1' }
	},
	{
		id: 'kg',
		dimension: 'mass',
		singular: 'kg',
		plural: 'kg',
		aliases: ['kilogram', 'kilograms', 'kilo', 'kilos'],
		toBase: { metric: '1000', us: '1000' }
	},
	{
		id: 'mg',
		dimension: 'mass',
		singular: 'mg',
		plural: 'mg',
		aliases: ['milligram', 'milligrams'],
		toBase: { metric: '0.001', us: '0.001' }
	},
	{
		id: 'oz',
		dimension: 'mass',
		singular: 'oz',
		plural: 'oz',
		aliases: ['ounce', 'ounces'],
		toBase: { metric: '28.349523', us: '28.349523' }
	},
	{
		id: 'lb',
		dimension: 'mass',
		singular: 'lb',
		plural: 'lb',
		aliases: ['pound', 'pounds', 'lbs'],
		toBase: { metric: '453.59237', us: '453.59237' }
	},
	{
		id: 'ml',
		dimension: 'volume',
		singular: 'ml',
		plural: 'ml',
		aliases: ['millilitre', 'milliliter', 'millilitres', 'milliliters', 'mls'],
		toBase: { metric: '1', us: '1' }
	},
	{
		id: 'l',
		dimension: 'volume',
		singular: 'l',
		plural: 'l',
		aliases: ['litre', 'liter', 'litres', 'liters', 'ltr'],
		toBase: { metric: '1000', us: '1000' }
	},
	{
		id: 'dl',
		dimension: 'volume',
		singular: 'dl',
		plural: 'dl',
		aliases: ['decilitre', 'deciliter', 'decilitres', 'deciliters'],
		toBase: { metric: '100', us: '100' }
	},
	{
		id: 'tsp',
		dimension: 'volume',
		singular: 'tsp',
		plural: 'tsp',
		aliases: ['teaspoon', 'teaspoons', 'ts'],
		toBase: { metric: '5', us: '4.92892' }
	},
	{
		id: 'tbsp',
		dimension: 'volume',
		singular: 'tbsp',
		plural: 'tbsp',
		aliases: ['tablespoon', 'tablespoons', 'tbs', 'tbl'],
		toBase: { metric: '15', us: '14.7868' }
	},
	{
		id: 'cup',
		dimension: 'volume',
		singular: 'cup',
		plural: 'cups',
		aliases: ['cups', 'c'],
		toBase: { metric: '250', us: '236.588' }
	},
	{
		id: 'fl_oz',
		dimension: 'volume',
		singular: 'fl oz',
		plural: 'fl oz',
		aliases: ['fl oz', 'floz', 'fluid ounce', 'fluid ounces', 'fl. oz'],
		toBase: { metric: '30', us: '29.5735' }
	},
	// US package units, for net-contents statements such as "1 GAL". A US
	// gallon has one fixed size, so both conventions hold the same factor: 128,
	// 32 and 16 US fluid ounces. Imperial gallons, quarts and pints are not
	// supported.
	{
		id: 'gal_us',
		dimension: 'volume',
		singular: 'gal',
		plural: 'gal',
		aliases: ['gallon', 'gallons'],
		toBase: { metric: '3785.408', us: '3785.408' }
	},
	{
		id: 'qt_us',
		dimension: 'volume',
		singular: 'qt',
		plural: 'qt',
		aliases: ['quart', 'quarts'],
		toBase: { metric: '946.352', us: '946.352' }
	},
	{
		id: 'pt_us',
		dimension: 'volume',
		singular: 'pt',
		plural: 'pt',
		aliases: ['pint', 'pints'],
		toBase: { metric: '473.176', us: '473.176' }
	},
	{
		id: 'piece',
		dimension: 'count',
		singular: 'piece',
		plural: 'pieces',
		aliases: ['pc', 'pcs', 'pieces', 'each', 'ea', 'whole', 'x', 'unit', 'units', 'item', 'items'],
		toBase: { metric: '1', us: '1' }
	},
	{
		id: 'can',
		dimension: 'package',
		singular: 'can',
		plural: 'cans',
		aliases: ['cans', 'tin', 'tins']
	},
	{ id: 'jar', dimension: 'package', singular: 'jar', plural: 'jars', aliases: ['jars'] },
	{ id: 'bag', dimension: 'package', singular: 'bag', plural: 'bags', aliases: ['bags'] },
	{
		id: 'package',
		dimension: 'package',
		singular: 'package',
		plural: 'packages',
		aliases: ['packages', 'pack', 'packs', 'packet', 'packets', 'pkg']
	},
	{
		id: 'bottle',
		dimension: 'package',
		singular: 'bottle',
		plural: 'bottles',
		aliases: ['bottles']
	},
	{ id: 'box', dimension: 'package', singular: 'box', plural: 'boxes', aliases: ['boxes'] },
	{ id: 'bunch', dimension: 'package', singular: 'bunch', plural: 'bunches', aliases: ['bunches'] },
	{ id: 'head', dimension: 'package', singular: 'head', plural: 'heads', aliases: ['heads'] },
	{ id: 'clove', dimension: 'package', singular: 'clove', plural: 'cloves', aliases: ['cloves'] },
	{ id: 'slice', dimension: 'package', singular: 'slice', plural: 'slices', aliases: ['slices'] },
	{ id: 'sprig', dimension: 'package', singular: 'sprig', plural: 'sprigs', aliases: ['sprigs'] },
	{ id: 'stick', dimension: 'package', singular: 'stick', plural: 'sticks', aliases: ['sticks'] },
	{ id: 'pinch', dimension: 'package', singular: 'pinch', plural: 'pinches', aliases: ['pinches'] },
	{ id: 'dash', dimension: 'package', singular: 'dash', plural: 'dashes', aliases: ['dashes'] },
	{
		id: 'handful',
		dimension: 'package',
		singular: 'handful',
		plural: 'handfuls',
		aliases: ['handfuls']
	}
];

const BY_ID = new Map(UNITS.map((u) => [u.id, u]));
const BY_ALIAS = new Map<string, string>();
for (const u of UNITS) {
	BY_ALIAS.set(u.id, u.id);
	BY_ALIAS.set(u.singular.toLowerCase(), u.id);
	BY_ALIAS.set(u.plural.toLowerCase(), u.id);
	for (const a of u.aliases) BY_ALIAS.set(a.toLowerCase(), u.id);
}
/** `toBase` parsed one time, so a conversion does no string parsing. */
const FACTORS = new Map<string, Record<Convention, Dec>>(
	UNITS.flatMap((u) =>
		u.toBase ? [[u.id, { metric: Dec.from(u.toBase.metric), us: Dec.from(u.toBase.us) }]] : []
	)
);
const THOUSAND = Dec.from(1000);

export function unitInfo(id: string | null | undefined): UnitDef | undefined {
	return id ? BY_ID.get(id) : undefined;
}

export function isUnitId(id: string): boolean {
	return BY_ID.has(id);
}

/** Map free text ("Grams", "Tbsp.", "pcs") to a canonical unit id, or null. */
export function normalizeUnitInput(raw: string): string | null {
	const key = raw.trim().toLowerCase().replace(/\.+$/, '').replace(/\s+/g, ' ');
	if (!key) return null;
	return BY_ALIAS.get(key) ?? null;
}

/**
 * The unit at the start of `words`, or null. "fl oz" is two words, so the
 * two-word unit is tried before the one-word unit. `words` is the count of
 * words the unit used.
 */
export function readUnitToken(words: readonly string[]): { unit: string; words: number } | null {
	for (const n of [2, 1]) {
		if (words.length < n) continue;
		const unit = normalizeUnitInput(words.slice(0, n).join(' '));
		if (unit) return { unit, words: n };
	}
	return null;
}

export function unitsCompatible(a: string, b: string): boolean {
	const ua = BY_ID.get(a);
	const ub = BY_ID.get(b);
	if (!ua || !ub) return false;
	if (ua.dimension === 'package' || ub.dimension === 'package') return ua.id === ub.id;
	return ua.dimension === ub.dimension;
}

export interface ConversionOptions {
	/** Ingredient-specific density, grams per millilitre. Enables volume<->mass. */
	gramsPerMl?: Dec | null;
}

/**
 * Convert an amount between units. Returns null when the conversion is not
 * defined: different dimensions without density, or any package unit.
 * Rounds only once, at the end.
 */
export function convertAmount(
	amount: Dec,
	from: string,
	to: string,
	convention: Convention,
	options: ConversionOptions = {}
): Dec | null {
	if (from === to) return amount;
	const uf = BY_ID.get(from);
	const ut = BY_ID.get(to);
	if (!uf || !ut) return null;
	if (uf.dimension === 'package' || ut.dimension === 'package') return null;
	const ff = FACTORS.get(from)?.[convention];
	const ft = FACTORS.get(to)?.[convention];
	if (!ff || !ft) return null;
	if (uf.dimension === ut.dimension) {
		return amount.mulDiv(ff, ft);
	}
	const density = options.gramsPerMl;
	if (!density || !density.isPositive()) return null;
	if (uf.dimension === 'volume' && ut.dimension === 'mass') {
		// amount * ff (ml) * density (g/ml) / ft
		return amount.mul(ff).mulDiv(density, ft);
	}
	if (uf.dimension === 'mass' && ut.dimension === 'volume') {
		// amount * ff (g) / density (g/ml) / ft
		return amount.mul(ff).div(density).div(ft);
	}
	return null;
}

/**
 * Singular for an amount above zero and at most one, plural for all others:
 * "1/2 cup", "1 cup", "1.5 cups", "0 cups".
 */
export function unitLabel(id: string | null | undefined, count: number | Dec = 1): string {
	const u = unitInfo(id);
	if (!u) return id ?? '';
	const size = (count instanceof Dec ? count : Dec.from(count)).abs();
	return size.isPositive() && size.lte(Dec.one) ? u.singular : u.plural;
}

/** Human-readable quantity such as "1.5 kg" or "3 cloves". */
export function formatQuantity(
	amount: Dec | null | undefined,
	unit: string | null | undefined
): string {
	if (amount === null || amount === undefined) return 'unknown amount';
	let value = amount;
	let unitId = unit ?? null;
	if (unitId === 'g' && value.gte(THOUSAND)) {
		value = value.div(THOUSAND);
		unitId = 'kg';
	} else if (unitId === 'ml' && value.gte(THOUSAND)) {
		value = value.div(THOUSAND);
		unitId = 'l';
	}
	const text = value.toHuman();
	if (!unitId) return text;
	return `${text} ${unitLabel(unitId, value)}`;
}
