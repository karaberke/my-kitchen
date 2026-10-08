/**
 * Words a product title may carry around an ingredient name without changing
 * what the ingredient is. A scan proposes an identity only when every word
 * left over after the brand and the matched name is in one of these sets, so
 * "Organic Whole Milk" proposes milk and "Chocolate Milk" proposes nothing.
 *
 * Compare with `isAttributeWord`, which normalizes both sides the way
 * `normalizeName` does ("2%" becomes "2").
 */

import { normalizeName } from './text';
import { UNITS } from './units';

/**
 * Every word of every mass and volume unit name ("g", "grams", "fl", "oz",
 * "gallon"), so a new unit is an attribute without a second list. Package and
 * count units ("can", "clove", "whole") are not here: they can name a
 * different product.
 */
const MEASURE_WORDS: readonly string[] = [
	...new Set(
		UNITS.filter((u) => u.dimension === 'mass' || u.dimension === 'volume')
			.flatMap((u) => [u.singular, u.plural, ...u.aliases])
			.flatMap((name) => normalizeName(name).split(' '))
	)
];

/** Harmless for any ingredient: quality, processing and package wording. */
export const GENERIC_ATTRIBUTES: readonly string[] = [
	'organic',
	'natural',
	'fresh',
	'large',
	'grade',
	'a',
	'pasteurized',
	'all',
	'pure',
	'premium',
	// size and pack wording
	'pack',
	'value',
	'family',
	'size',
	'count',
	'ct',
	'half',
	...MEASURE_WORDS
];

/** Harmless for one ingredient only, keyed by its normalized catalog name. */
export const INGREDIENT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
	milk: [
		'whole',
		'2%',
		'1%',
		'reduced',
		'low',
		'fat',
		'skim',
		'fat-free',
		'lactose-free',
		'vitamin',
		'd',
		'homogenized',
		'ultra'
	]
};

const GENERIC = new Set(GENERIC_ATTRIBUTES.map(normalizeName));
const BY_INGREDIENT = new Map(
	Object.entries(INGREDIENT_ATTRIBUTES).map(([name, words]) => [
		normalizeName(name),
		new Set(words.map(normalizeName))
	])
);

/**
 * True when one normalized title word leaves the ingredient unchanged. A bare
 * number is a size ("1 gallon", "12 pack").
 */
export function isAttributeWord(word: string, ingredientName: string): boolean {
	if (/^\d+$/.test(word)) return true;
	if (GENERIC.has(word)) return true;
	return BY_INGREDIENT.get(normalizeName(ingredientName))?.has(word) ?? false;
}
