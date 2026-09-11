import { describe, expect, it } from 'vitest';
import { ingredientLine } from './ingredient-line';

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
