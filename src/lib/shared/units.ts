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

export const UNIT_IDS: readonly string[] = UNITS.map((u) => u.id);

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
	if (!uf.toBase || !ut.toBase) return null;
	const ff = Dec.from(uf.toBase[convention]);
	const ft = Dec.from(ut.toBase[convention]);
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

export function unitLabel(id: string | null | undefined, count: number | Dec = 1): string {
	const u = unitInfo(id);
	if (!u) return id ?? '';
	const isOne = count instanceof Dec ? count.eq(Dec.one) : count === 1;
	return isOne ? u.singular : u.plural;
}

/** Human-readable quantity such as "1.5 kg" or "3 cloves". */
export function formatQuantity(
	amount: Dec | null | undefined,
	unit: string | null | undefined
): string {
	if (amount === null || amount === undefined) return 'unknown amount';
	let value = amount;
	let unitId = unit ?? null;
	if (unitId === 'g' && value.gte(Dec.from(1000))) {
		value = value.mulRatio(1, 1000);
		unitId = 'kg';
	} else if (unitId === 'ml' && value.gte(Dec.from(1000))) {
		value = value.mulRatio(1, 1000);
		unitId = 'l';
	}
	const text = value.toHuman();
	if (!unitId) return text;
	return `${text} ${unitLabel(unitId, value)}`;
}

export const CONVENTIONS: readonly Convention[] = ['metric', 'us'];
