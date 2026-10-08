/**
 * The aisles of a grocery list, in the order a shop is walked. "Other" is last.
 * Shared so the browser sorts by the same list the server validates against.
 */
export const GROCERY_CATEGORIES = [
	'Produce',
	'Meat & fish',
	'Dairy & eggs',
	'Bakery',
	'Pantry',
	'Spices',
	'Frozen',
	'Beverages',
	'Household',
	'Other'
] as const;

export type GroceryCategory = (typeof GROCERY_CATEGORIES)[number];

/** The catch-all aisle. */
export const OTHER_CATEGORY: GroceryCategory = 'Other';

export function isGroceryCategory(value: string): value is GroceryCategory {
	return (GROCERY_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The walking position of an aisle. A category that is not in the list (an
 * older or hand-typed one) goes after the known aisles and before "Other".
 */
export function aisleIndex(category: string): number {
	if (category === OTHER_CATEGORY) return GROCERY_CATEGORIES.length;
	const i = (GROCERY_CATEGORIES as readonly string[]).indexOf(category);
	return i === -1 ? GROCERY_CATEGORIES.length - 1 : i;
}

/** Sort comparator for aisle names: shop order, unknown ones A–Z among themselves. */
export function compareAisles(a: string, b: string): number {
	return aisleIndex(a) - aisleIndex(b) || a.localeCompare(b);
}
