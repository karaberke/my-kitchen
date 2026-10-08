import { describe, expect, it } from 'vitest';
import { isAttributeWord } from './ingredient-attributes';

describe('isAttributeWord', () => {
	it('accepts the size words of every mass and volume unit', () => {
		for (const word of ['gallon', 'gal', 'quart', 'qt', 'pint', 'pt', 'oz', 'fl', 'lb', 'l']) {
			expect(isAttributeWord(word, 'milk')).toBe(true);
		}
		for (const word of ['ml', 'g', 'kg', 'grams', 'litre', 'ounces', 'tbsp', 'cups']) {
			expect(isAttributeWord(word, 'flour')).toBe(true);
		}
	});

	it('accepts quality words and bare numbers', () => {
		expect(isAttributeWord('organic', 'milk')).toBe(true);
		expect(isAttributeWord('12', 'eggs')).toBe(true);
	});

	it('accepts words that are harmless for one ingredient only', () => {
		expect(isAttributeWord('whole', 'Milk')).toBe(true);
		expect(isAttributeWord('whole', 'flour')).toBe(false);
	});

	it('rejects words that change the ingredient, and package units', () => {
		expect(isAttributeWord('chocolate', 'milk')).toBe(false);
		expect(isAttributeWord('clove', 'garlic')).toBe(false);
		expect(isAttributeWord('can', 'tomatoes')).toBe(false);
	});
});
