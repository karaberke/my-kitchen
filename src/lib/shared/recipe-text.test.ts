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

describe('parseRecipeText with PDF line wrapping', () => {
	const WRAPPED = [
		`Boba Shop Cheese Foam
The actual "cheese foam" boba shops use — cream cheese based, thicker and richer than
Starbucks-style cold foam, with that signature savory-salty-sweet finish
Ingredients
2 tbsp cream cheese
2 tbsp milk
Steps
1. Let 2 tbsp cream cheese sit out for 10-15 minutes until soft, or microwave in 5-second
bursts.
2. In a bowl, whisk the softened cream cheese with 2 tbsp milk, 1 tbsp sugar or
honey, until smooth.`
	];

	it('keeps a description that wrapped onto a second line whole', () => {
		const r = parseRecipeText(WRAPPED);
		expect(r.input.description).toBe(
			'The actual "cheese foam" boba shops use — cream cheese based, thicker and richer than Starbucks-style cold foam, with that signature savory-salty-sweet finish'
		);
	});

	it('joins a step that wrapped mid-sentence instead of splitting it', () => {
		const r = parseRecipeText(WRAPPED);
		expect(r.input.steps.map((s) => s.text)).toEqual([
			'Let 2 tbsp cream cheese sit out for 10-15 minutes until soft, or microwave in 5-second bursts.',
			'In a bowl, whisk the softened cream cheese with 2 tbsp milk, 1 tbsp sugar or honey, until smooth.'
		]);
	});

	it('strips the source numbering, since the form numbers steps itself', () => {
		const r = parseRecipeText(['Soup\nSteps\n1. Chop.\n2. Simmer.']);
		expect(r.input.steps.map((s) => s.text)).toEqual(['Chop.', 'Simmer.']);
	});

	it('never joins two separate ingredient lines', () => {
		const r = parseRecipeText(WRAPPED);
		expect(r.input.ingredients.map((i) => i.name)).toEqual(['cream cheese', 'milk']);
	});

	it('reads separate metadata values, measured groups and numbered direction labels from PDF text', () => {
		const { input } = parseRecipeText([
			`Basic Crêpes
Recipe Overview
Prep Time
10 mins
Cook Time
20 mins
Total Time
30 mins
Servings
4
Yield
8 crêpes
Ingredients
Eggs: 2 large
Milk & Water: ½ cup milk (plus more if needed) and ½ cup water
Seasoning & Base: ¼ teaspoon salt, 1 cup all-purpose flour, and 2 tablespoons melted butter
Directions
1. Mix the batter:
Whisk eggs, milk, water, and salt together, then incorporate the flour and melted butter until smooth and
pourable (a blender may also be used).
2. Cook:
Heat a lightly oiled pan over medium-high heat, pour about ¼ cup batter, and swirl to coat the surface. Cook
until the top is set and bottom is light brown (1–2 minutes), then loosen, flip, and cook for about 1 minute
more.
3. Serve:
Serve hot.
Source: https://example.test/basic-crepes/`
		]);
		expect(input).toMatchObject({
			title: 'Basic Crêpes',
			prepMinutes: '10',
			cookMinutes: '20',
			baseServings: '4',
			yieldNote: '8 crêpes',
			source: 'https://example.test/basic-crepes/'
		});
		expect(input.ingredients.map((i) => [i.amount, i.unit])).toEqual([
			['2', ''],
			['0.5', 'cup'],
			['0.5', 'cup'],
			['0.25', 'tsp'],
			['1', 'cup'],
			['2', 'tbsp']
		]);
		expect(input.steps).toHaveLength(3);
		expect(input.steps[0].text).toContain(
			'until smooth and pourable (a blender may also be used).'
		);
		expect(input.steps[1].text).toContain('flip, and cook for about 1 minute more.');
		expect(input.steps[2].text).toContain('Serve hot.');
		expect(input.notes).toContain('Milk & Water: ½ cup milk (plus more if needed) and ½ cup water');
	});

	it('reads named step numbers and a separate non-numeric yield without creating extra steps', () => {
		const { input } = parseRecipeText([
			'Lemon Loaf\nServings: 8\nIngredients\n180 g plain flour\nDirections\nStep 1\nMix the batter gently.\nStep 2\nBake until golden.\nYield\none loaf'
		]);
		expect(input.baseServings).toBe('8');
		expect(input.yieldNote).toBe('one loaf');
		expect(input.steps.map((s) => s.text)).toEqual([
			'Mix the batter gently.',
			'Bake until golden.'
		]);
		expect(input.notes).toContain('Yield\none loaf');
	});
});
