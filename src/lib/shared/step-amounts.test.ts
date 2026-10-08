import { describe, expect, it } from 'vitest';
import { Dec } from './decimal';
import {
	findStepAmounts,
	prepareStepIngredients,
	scaleStepParts,
	scaleStepText,
	scaledStepLine
} from './step-amounts';

const ingredients = [
	{ name: 'plain flour', amount: '200', unit: 'g' },
	{ name: 'eggs', amount: '2', unit: null },
	{ name: 'brown sugar', amount: '50', unit: 'g' },
	{ name: 'sugar', amount: '100', unit: 'g' },
	{ name: 'olive oil', amount: '2', unit: 'tbsp' },
	{ name: 'sesame oil', amount: '1', unit: 'tbsp' },
	{ name: 'milk', amount: '0.5', unit: 'cup' },
	{ name: 'butter, softened', amount: '125', unit: 'g' },
	{ name: 'garlic', amount: '3', unit: 'clove' }
];

const base = Dec.from('4');
const double = (text: string) => scaledStepLine(text, ingredients, base, Dec.from('8'));
const linked = (text: string) =>
	findStepAmounts(text, ingredients).flatMap((p) => ('amount' in p ? [p.ingredient] : []));

describe('findStepAmounts: amounts that stay as written', () => {
	it.each([
		'Bake at 180 °C for 25 minutes.',
		'Use a 23 cm tin.',
		'Step 2: rest the dough.',
		'Cut into 4 pieces.',
		// Two oils in tbsp and no name to choose between them.
		'Add 2 tbsp oil.',
		// Grams of flour cannot be cups.
		'Add 2 cups flour.',
		// No name, and no ingredient has exactly 30 g.
		'Add 30 g and stir.',
		'Leave for 10:30 minutes.',
		'Repeat 2 and 3 times.'
	])('%s', (text) => {
		expect(linked(text)).toEqual([]);
		expect(double(text)).toBe(text);
	});
});

describe('findStepAmounts: amounts that link to an ingredient', () => {
	it('links by the name after the amount and unit', () => {
		expect(linked('Add 200 g flour, then whisk in 2 eggs.')).toEqual([0, 1]);
	});

	it('reads "of the" and plural names', () => {
		expect(linked('Stir in 100 g of the sugar and 3 cloves garlic.')).toEqual([3, 8]);
	});

	it('prefers the longer name', () => {
		expect(linked('Add 50 g brown sugar, then 100 g sugar.')).toEqual([2, 3]);
	});

	it('links a name after a comma in the ingredient', () => {
		expect(linked('Cream 125 g butter.')).toEqual([7]);
	});

	it('links an amount with no name when one ingredient has exactly it', () => {
		expect(linked('Add 125 g and stir.')).toEqual([7]);
	});
});

describe('prepareStepIngredients', () => {
	it('matches like the raw list, so a recipe can prepare it one time', () => {
		const text = 'Add 200 g flour, 2 eggs and 1 tbsp sesame oil.';
		expect(findStepAmounts(text, prepareStepIngredients(ingredients))).toEqual(
			findStepAmounts(text, ingredients)
		);
	});

	it('scales parts found one time to other servings', () => {
		const parts = findStepAmounts('Add 200 g flour.', prepareStepIngredients(ingredients));
		expect(scaleStepParts(parts, base, Dec.from('8')).map((p) => p.text)).toEqual([
			'Add ',
			'400 g',
			' flour.'
		]);
		expect(scaleStepParts(parts, base, Dec.from('2')).map((p) => p.text)).toEqual([
			'Add ',
			'100 g',
			' flour.'
		]);
	});
});

describe('scaleStepText', () => {
	it('scales linked amounts and leaves the rest', () => {
		expect(double('Add 200 g flour, then bake at 180 °C for 25 minutes.')).toBe(
			'Add 400 g flour, then bake at 180 °C for 25 minutes.'
		);
		expect(double('Whisk in 2 eggs.')).toBe('Whisk in 4 eggs.');
	});

	it('scales fractions and ranges', () => {
		expect(double('Pour in ½ cup milk.')).toBe('Pour in 1 cup milk.');
		expect(double('Add 2-3 tbsp olive oil.')).toBe('Add 4–6 tbsp olive oil.');
	});

	it('keeps the original wording at the base servings', () => {
		const text = 'Add 200 grams flour and 1/2 cup milk.';
		expect(scaledStepLine(text, ingredients, base, base)).toBe(text);
	});

	it('marks a changed amount with what the step wrote', () => {
		const parts = scaleStepText('Add 200 g flour.', ingredients, base, Dec.from('2'));
		expect(parts).toEqual([
			{ text: 'Add ', original: null },
			{ text: '100 g', original: '200 g' },
			{ text: ' flour.', original: null }
		]);
	});

	it('writes amounts with the format it is given', () => {
		const parts = scaleStepText(
			'Add 200 g flour.',
			ingredients,
			base,
			base,
			(a) => `${a.toHuman()} grams`
		);
		expect(parts.map((p) => p.text).join('')).toBe('Add 200 grams flour.');
	});
});
