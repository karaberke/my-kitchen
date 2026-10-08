/**
 * The evaluation set for ingredient matching: resolve (automatic link on
 * pantry add), scan proposal (provider title -> proposal, from a barcode
 * lookup) and dropdown (retrieval for the autocomplete). Pure data, no
 * imports, so both the tests and any script can read it.
 *
 * `expected` / `notExpected` are catalog ingredient names
 * (scripts/catalog-data.mjs). A wrong automatic link (resolve or scan) is a
 * failure; a missing one is acceptable. The dropdown only needs `expected`
 * inside the top 5 results.
 */

export interface ResolveCase {
	input: string;
	/** A catalog ingredient name, or null when nothing should resolve. */
	expected: string | null;
	/** Catalog ingredient names this input must never resolve to. */
	notExpected?: string[];
}

export interface ScanCase {
	title: string;
	brand: string;
	/** A catalog ingredient name, or null when no proposal should be made. */
	expected: string | null;
}

export interface DropdownCase {
	query: string;
	/** A catalog ingredient name expected inside the top 5 results. */
	expected: string;
}

export const RESOLVE_CASES: ResolveCase[] = [
	{ input: 'carrots', expected: 'carrot' },
	{ input: 'scallions', expected: 'green onion' },
	{ input: 'Tomatoes', expected: 'tomato' },
	{ input: 'milk', expected: 'milk' },
	{ input: 'chocolate milk', expected: null, notExpected: ['milk', 'chocolate'] },
	{ input: 'almond milk', expected: null, notExpected: ['milk'] },
	{ input: 'milk powder', expected: null, notExpected: ['milk'] },
	{ input: 'tomato sauce', expected: null, notExpected: ['tomato'] },
	{ input: 'milk chocolate', expected: null, notExpected: ['milk', 'chocolate'] },
	{ input: 'pears', expected: null, notExpected: ['frozen peas'] }
];

export const SCAN_CASES: ScanCase[] = [
	{
		title: 'Kirkland Signature Organic Whole Milk',
		brand: 'Kirkland Signature',
		expected: 'milk'
	},
	{ title: 'Organic Chocolate Milk', brand: '', expected: null },
	{ title: 'Unsweetened Almond Milk', brand: '', expected: null },
	{ title: 'Tomato Sauce', brand: '', expected: null }
];

export const DROPDOWN_CASES: DropdownCase[] = [
	{ query: 'breast', expected: 'chicken breast' },
	{ query: 'cinamon', expected: 'cinnamon' },
	{ query: 'whole milk org', expected: 'milk' },
	{ query: 'scallions', expected: 'green onion' }
];
