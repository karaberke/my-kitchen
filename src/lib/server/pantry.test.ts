import { describe, expect, it } from 'vitest';
import { scanNewIngredientName, scanOrigin } from './pantry';

const scan = (over: Partial<Parameters<typeof scanNewIngredientName>[0]> = {}) => ({
	ingredientId: null,
	name: 'Oat drink',
	providerTitle: 'Oat drink',
	createIdentity: false,
	...over
});

describe('scanNewIngredientName', () => {
	it('makes no ingredient from the untouched product title', () => {
		expect(scanNewIngredientName(scan())).toBeNull();
	});

	it('makes one from a typed name or the explicit option', () => {
		expect(scanNewIngredientName(scan({ name: ' oat milk ' }))).toBe('oat milk');
		expect(scanNewIngredientName(scan({ createIdentity: true }))).toBe('Oat drink');
	});

	it('makes none when an ingredient is chosen', () => {
		expect(
			scanNewIngredientName(scan({ ingredientId: 'i', name: 'oat milk', createIdentity: true }))
		).toBeNull();
	});
});

describe('scanOrigin', () => {
	it('keeps a known provider and treats anything else as manual', () => {
		expect(scanOrigin('usda')).toBe('usda');
		expect(scanOrigin('off')).toBe('off');
		expect(scanOrigin('evil')).toBe('manual');
		expect(scanOrigin('')).toBe('manual');
	});
});
