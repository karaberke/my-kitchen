import { describe, expect, it } from 'vitest';
import { ingredientLine, parseGroceryEntry, splitIngredientLine } from './ingredient-line';

describe('ingredientLine', () => {
	it('appends a preparation note', () => {
		expect(ingredientLine({ quantity: '200 g', name: 'onion', preparation: 'diced' })).toBe(
			'200 g onion, diced'
		);
	});

	it('drops the original wording an import kept, which the line already says', () => {
		expect(
			ingredientLine({
				quantity: '2 tbsp',
				name: 'cream cheese',
				preparation: '2 tbsp cream cheese'
			})
		).toBe('2 tbsp cream cheese');
	});

	it('drops the original wording when the amount is written differently', () => {
		expect(
			ingredientLine({
				quantity: '0.13 tsp',
				name: 'sea salt (fine)',
				preparation: '1/8 tsp sea salt (fine)'
			})
		).toBe('0.13 tsp sea salt (fine)');
	});

	it('keeps a note that gives a measurement of its own', () => {
		expect(
			ingredientLine({ quantity: '1 kg', name: 'potatoes', preparation: 'cut into 2 cm cubes' })
		).toBe('1 kg potatoes, cut into 2 cm cubes');
	});

	it('keeps a note that repeats the name but gives no amount', () => {
		expect(ingredientLine({ quantity: '1', name: 'egg', preparation: 'beaten egg' })).toBe(
			'1 egg, beaten egg'
		);
	});

	it('writes the name alone when there is no quantity and no note', () => {
		expect(ingredientLine({ quantity: '', name: 'chicken thighs', preparation: '' })).toBe(
			'chicken thighs'
		);
	});
});

describe('splitIngredientLine', () => {
	const split = (s: string) => {
		const r = splitIngredientLine(s);
		return [r.amount, r.unit, r.name];
	};

	it('splits a plain metric quantity', () => {
		expect(split('200 g red lentils')).toEqual(['200', 'g', 'red lentils']);
		expect(split('1 tbsp olive oil')).toEqual(['1', 'tbsp', 'olive oil']);
	});

	it('handles a missing space between amount and unit', () => {
		expect(split('200g red lentils')).toEqual(['200', 'g', 'red lentils']);
	});

	it('reads fractions and mixed numbers', () => {
		expect(split('½ tsp cumin')).toEqual(['0.5', 'tsp', 'cumin']);
		expect(split('1 1/2 cups flour')).toEqual(['1.5', 'cup', 'flour']);
		expect(split('1½ cups flour')).toEqual(['1.5', 'cup', 'flour']);
	});

	it('normalises unit spellings', () => {
		expect(split('2 tablespoons butter')).toEqual(['2', 'tbsp', 'butter']);
		expect(split('3 cloves garlic')).toEqual(['3', 'clove', 'garlic']);
	});

	it('drops a connecting "of"', () => {
		expect(split('1 cup of milk')).toEqual(['1', 'cup', 'milk']);
	});

	it('leaves the amount alone when the next word is not a unit', () => {
		expect(split('2 large eggs')).toEqual(['2', '', 'large eggs']);
	});

	it('keeps an unquantified ingredient as just a name', () => {
		expect(split('salt')).toEqual(['', '', 'salt']);
		expect(split('freshly ground black pepper')).toEqual(['', '', 'freshly ground black pepper']);
	});

	it('takes the low end of a range so the amount stays usable', () => {
		expect(split('2-3 tbsp water')).toEqual(['2', 'tbsp', 'water']);
	});

	it('always keeps the original wording', () => {
		expect(splitIngredientLine('200 g red lentils').original).toBe('200 g red lentils');
		expect(splitIngredientLine('  salt  ').original).toBe('salt');
	});

	it('does not choke on an empty line', () => {
		expect(split('')).toEqual(['', '', '']);
	});
});

describe('parseGroceryEntry', () => {
	const read = (text: string) => {
		const e = parseGroceryEntry(text);
		return e && { amount: e.amount.toString(), unit: e.unit, name: e.name };
	};

	it('splits a plain amount, unit and name', () => {
		expect(read('400 g chopped tomatoes')).toEqual({
			amount: '400',
			unit: 'g',
			name: 'chopped tomatoes'
		});
		expect(read('400g rice')).toEqual({ amount: '400', unit: 'g', name: 'rice' });
		expect(read('1 1/2 l milk')).toEqual({ amount: '1.5', unit: 'l', name: 'milk' });
		expect(read('2 eggs')).toEqual({ amount: '2', unit: null, name: 'eggs' });
	});

	it('keeps a multiplier or a second number as typed', () => {
		expect(read('2x tins chopped tomatoes 400g')).toBeNull();
		expect(read('2 x eggs')).toBeNull();
		expect(read('3 × 400 g beans')).toBeNull();
		expect(read('2 tins tomatoes 400g')).toBeNull();
	});

	it('keeps text without a plain amount as typed', () => {
		expect(read('tomatoes')).toBeNull();
		expect(read('7up')).toBeNull();
		expect(read('0 eggs')).toBeNull();
		expect(read('400 g')).toBeNull();
		expect(read('')).toBeNull();
	});
});
