import { describe, expect, it } from 'vitest';
import { parseRecipeText } from './recipe-text';

const PAGES = [
	`Coconut Red Lentil Dal
Weeknight dal from the blog archive, adapted for one pot.
Serves 4
Prep 10 min

Ingredients
300 g red lentils, rinsed
1 can (400 ml) full-fat coconut milk
1 tbsp curry powder`,
	`100 g baby spinach

Method
Rinse the lentils until the water runs clear.
Simmer until soft, about 30 minutes.`
];

describe('parseRecipeText', () => {
	it('takes the title from the first meaningful line', () => {
		const r = parseRecipeText(PAGES);
		expect(r.input.title).toBe('Coconut Red Lentil Dal');
		expect(r.input.description).toBe('Weeknight dal from the blog archive, adapted for one pot.');
	});

	it('reads servings and times when the text states them', () => {
		const r = parseRecipeText(PAGES);
		expect(r.input.baseServings).toBe('4');
		expect(r.input.prepMinutes).toBe('10');
		// Nothing said about cook time, so nothing is invented.
		expect(r.input.cookMinutes).toBe('');
	});

	it('splits ingredients from steps using the section headings', () => {
		const r = parseRecipeText(PAGES);
		expect(r.input.ingredients.map((i) => [i.amount, i.unit, i.name])).toEqual([
			['300', 'g', 'red lentils, rinsed'],
			['400', 'ml', 'full-fat coconut milk'],
			['1', 'tbsp', 'curry powder'],
			['100', 'g', 'baby spinach']
		]);
		expect(r.input.steps.map((s) => s.text)).toEqual([
			'Rinse the lentils until the water runs clear.',
			'Simmer until soft, about 30 minutes.'
		]);
	});

	it('records which page each ingredient came from', () => {
		const r = parseRecipeText(PAGES);
		expect(r.ingredientPages).toEqual([1, 1, 1, 2]);
	});

	it('accepts Instructions and Directions as step headings too', () => {
		for (const heading of ['Instructions', 'Directions', 'Steps']) {
			const r = parseRecipeText([`Soup\n\nIngredients\n1 tbsp oil\n\n${heading}\nHeat the oil.`]);
			expect(r.input.steps.map((s) => s.text)).toEqual(['Heat the oil.']);
			expect(r.input.ingredients).toHaveLength(1);
		}
	});

	it('falls back to quantity detection when there are no headings', () => {
		const r = parseRecipeText([
			'Quick soup\n200 g carrots\n1 tbsp oil\nChop the carrots and fry them gently until soft.'
		]);
		expect(r.input.ingredients.map((i) => i.name)).toEqual(['carrots', 'oil']);
		expect(r.input.steps.map((s) => s.text)).toEqual([
			'Chop the carrots and fry them gently until soft.'
		]);
	});

	it('reads "4 servings" as well as "Serves 4"', () => {
		expect(parseRecipeText(['Pie\n4 servings\n']).input.baseServings).toBe('4');
		expect(parseRecipeText(['Pie\nYield: 6\n']).input.baseServings).toBe('6');
	});

	it('reads hours in a time line', () => {
		const r = parseRecipeText(['Stew\nPrep: 15 min\nCook: 1 hr 30 min\n']);
		expect(r.input.prepMinutes).toBe('15');
		expect(r.input.cookMinutes).toBe('90');
	});

	it('keeps the full text so nothing is lost', () => {
		const r = parseRecipeText(PAGES);
		expect(r.input.notes).toContain('Coconut Red Lentil Dal');
		expect(r.input.notes).toContain('Simmer until soft');
	});

	it('reports when there was no readable text at all', () => {
		const r = parseRecipeText([]);
		expect(r.empty).toBe(true);
		expect(r.input.title).toBe('');
		expect(parseRecipeText(['   \n  \n']).empty).toBe(true);
	});
});
