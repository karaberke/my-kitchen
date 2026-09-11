import { describe, expect, it } from 'vitest';
import { readImportedRecipe } from './import-payload';

const payload = (input: Record<string, unknown> = {}) =>
	JSON.stringify({
		source: 'json-ld',
		pageCount: null,
		input: {
			title: 'Dal',
			description: '',
			baseServings: '4',
			yieldNote: '',
			prepMinutes: '',
			cookMinutes: '',
			source: '',
			notes: '',
			tags: '',
			convention: 'metric',
			ingredients: [],
			steps: [],
			...input
		}
	});

describe('readImportedRecipe', () => {
	it('keeps the picture the browser found', () => {
		const read = readImportedRecipe(payload({ imageUrl: 'https://example.com/dal.jpg' }));
		expect(read?.input.imageUrl).toBe('https://example.com/dal.jpg');
	});

	it('gives an empty picture link when the browser sent none', () => {
		expect(readImportedRecipe(payload())?.input.imageUrl).toBe('');
	});

	it('refuses a payload that is not a recipe', () => {
		expect(readImportedRecipe('{"nope":1}')).toBeNull();
	});
});
