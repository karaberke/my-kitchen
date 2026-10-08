import { describe, expect, it } from 'vitest';
import {
	GROCERY_CATEGORIES,
	aisleIndex,
	compareAisles,
	isGroceryCategory
} from './grocery-categories';

describe('aisle order', () => {
	it('follows GROCERY_CATEGORIES with Other last', () => {
		const shuffled = [...GROCERY_CATEGORIES].reverse();
		expect(shuffled.sort(compareAisles)).toEqual([...GROCERY_CATEGORIES]);
		expect(GROCERY_CATEGORIES.at(-1)).toBe('Other');
	});

	it('puts unknown categories after the known ones and before Other, A–Z', () => {
		const sorted = ['Other', 'Zebra', 'Produce', 'Apples', 'Household'].sort(compareAisles);
		expect(sorted).toEqual(['Produce', 'Household', 'Apples', 'Zebra', 'Other']);
		expect(aisleIndex('Zebra')).toBeGreaterThan(aisleIndex('Household'));
		expect(aisleIndex('Zebra')).toBeLessThan(aisleIndex('Other'));
	});

	it('knows the list', () => {
		expect(isGroceryCategory('Frozen')).toBe(true);
		expect(isGroceryCategory('frozen')).toBe(false);
	});
});
