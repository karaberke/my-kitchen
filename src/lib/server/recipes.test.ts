import { describe, expect, it } from 'vitest';
import { Dec } from '$lib/shared/decimal';
import {
	recipeToPlainText,
	type RecipeDetail,
	type RecipeIngredientView
} from '$lib/server/recipes';

const ingredient = (over: Partial<RecipeIngredientView>): RecipeIngredientView => ({
	id: 'i',
	position: 0,
	groupName: '',
	ingredientId: null,
	name: 'flour',
	amount: '200',
	unit: 'g',
	preparation: '',
	optional: false,
	ingredientCategory: null,
	stockAvailable: null,
	stockOther: [],
	...over
});

const recipe = (over: Partial<RecipeDetail> = {}): RecipeDetail =>
	({
		id: 'r',
		title: 'Pancakes',
		description: '',
		baseServings: '4',
		yieldNote: '',
		prepMinutes: null,
		cookMinutes: null,
		notes: '',
		ingredients: [
			ingredient({ name: 'flour', amount: '200', unit: 'g' }),
			ingredient({ name: 'eggs', amount: '2', unit: null, position: 1 }),
			ingredient({ name: 'salt', amount: null, unit: null, position: 2 }),
			ingredient({ name: 'milk', amount: '0.75', unit: 'l', position: 3 })
		],
		steps: [{ id: 's', position: 0, sectionTitle: '', text: 'Mix and fry.' }],
		...over
	}) as RecipeDetail;

describe('recipeToPlainText', () => {
	it('prints the stored amounts and servings when no servings are given', () => {
		const text = recipeToPlainText(recipe());
		expect(text).toContain('Serves 4');
		expect(text).toContain('  - 200 g flour');
		expect(text).toContain('  - 2 eggs');
		expect(text).toContain('  - salt');
		expect(recipeToPlainText(recipe(), undefined)).toBe(text);
	});

	it('scales every amount in code and shows the servings asked for', () => {
		const text = recipeToPlainText(recipe(), Dec.from('8'));
		expect(text).toContain('Serves 8');
		expect(text).toContain('  - 400 g flour');
		expect(text).toContain('  - 4 eggs');
		expect(text).toContain('  - 1.5 l milk');
		expect(text).not.toContain('Serves 4');
		expect(text).not.toContain('200 g');
	});

	it('scales down, and keeps an unknown amount unknown', () => {
		const text = recipeToPlainText(recipe(), Dec.from('1'));
		expect(text).toContain('Serves 1');
		expect(text).toContain('  - 50 g flour');
		expect(text).toContain('  - salt');
		expect(text).not.toMatch(/0 salt/);
	});

	it('keeps the stored text when servings equal the base servings', () => {
		expect(recipeToPlainText(recipe(), Dec.from('4'))).toBe(recipeToPlainText(recipe()));
	});

	it('does not scale a recipe without base servings', () => {
		const base = recipe({ baseServings: null });
		const text = recipeToPlainText(base, Dec.from('8'));
		expect(text).toBe(recipeToPlainText(base));
		expect(text).toContain('  - 200 g flour');
		expect(text).not.toContain('Serves');
	});

	it('ignores zero servings and zero base servings', () => {
		expect(recipeToPlainText(recipe(), Dec.from('0'))).toBe(recipeToPlainText(recipe()));
		const zeroBase = recipe({ baseServings: '0' });
		expect(recipeToPlainText(zeroBase, Dec.from('8'))).toContain('  - 200 g flour');
	});
});
