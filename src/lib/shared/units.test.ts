import { describe, expect, it } from 'vitest';
import { Dec } from './decimal';
import {
	UNITS,
	unitInfo,
	unitsCompatible,
	convertAmount,
	formatQuantity,
	normalizeUnitInput,
	unitLabel
} from './units';

describe('unit catalog', () => {
	it('defines mass, volume, count and package units with dimensions', () => {
		expect(unitInfo('g')?.dimension).toBe('mass');
		expect(unitInfo('kg')?.dimension).toBe('mass');
		expect(unitInfo('ml')?.dimension).toBe('volume');
		expect(unitInfo('l')?.dimension).toBe('volume');
		expect(unitInfo('cup')?.dimension).toBe('volume');
		expect(unitInfo('piece')?.dimension).toBe('count');
		expect(unitInfo('can')?.dimension).toBe('package');
		expect(unitInfo('clove')?.dimension).toBe('package');
		expect(unitInfo('nope')).toBeUndefined();
		expect(UNITS.length).toBeGreaterThan(10);
	});

	it('normalises common spellings to canonical ids', () => {
		expect(normalizeUnitInput('grams')).toBe('g');
		expect(normalizeUnitInput('G')).toBe('g');
		expect(normalizeUnitInput('kilogram')).toBe('kg');
		expect(normalizeUnitInput('mL')).toBe('ml');
		expect(normalizeUnitInput('liters')).toBe('l');
		expect(normalizeUnitInput('tablespoons')).toBe('tbsp');
		expect(normalizeUnitInput('Tbsp.')).toBe('tbsp');
		expect(normalizeUnitInput('cups')).toBe('cup');
		expect(normalizeUnitInput('pcs')).toBe('piece');
		expect(normalizeUnitInput('cloves')).toBe('clove');
		expect(normalizeUnitInput('')).toBeNull();
		expect(normalizeUnitInput('furlongs')).toBeNull();
	});
});

describe('unitsCompatible', () => {
	it('matches within mass, volume and count dimensions', () => {
		expect(unitsCompatible('g', 'kg')).toBe(true);
		expect(unitsCompatible('ml', 'cup')).toBe(true);
		expect(unitsCompatible('piece', 'piece')).toBe(true);
	});
	it('never matches across dimensions or between different package units', () => {
		expect(unitsCompatible('g', 'ml')).toBe(false);
		expect(unitsCompatible('can', 'g')).toBe(false);
		expect(unitsCompatible('can', 'bag')).toBe(false);
		expect(unitsCompatible('can', 'can')).toBe(true);
		expect(unitsCompatible('clove', 'piece')).toBe(false);
	});
});

describe('convertAmount', () => {
	it('converts kg/g and L/mL exactly', () => {
		expect(convertAmount(Dec.from('1.5'), 'kg', 'g', 'metric')?.toString()).toBe('1500');
		expect(convertAmount(Dec.from('250'), 'g', 'kg', 'metric')?.toString()).toBe('0.25');
		expect(convertAmount(Dec.from('2'), 'l', 'ml', 'metric')?.toString()).toBe('2000');
	});

	it('uses the recipe convention for cups and spoons', () => {
		expect(convertAmount(Dec.from('1'), 'cup', 'ml', 'metric')?.toString()).toBe('250');
		expect(convertAmount(Dec.from('1'), 'cup', 'ml', 'us')?.toString()).toBe('236.588');
		expect(convertAmount(Dec.from('1'), 'tbsp', 'ml', 'metric')?.toString()).toBe('15');
		expect(convertAmount(Dec.from('1'), 'tbsp', 'ml', 'us')?.toString()).toBe('14.7868');
		expect(convertAmount(Dec.from('1'), 'tsp', 'ml', 'us')?.toString()).toBe('4.92892');
	});

	it('refuses volume to mass without an explicit density', () => {
		expect(convertAmount(Dec.from('1'), 'cup', 'g', 'metric')).toBeNull();
	});

	it('converts volume to mass when an ingredient density (g per ml) is given', () => {
		expect(
			convertAmount(Dec.from('1'), 'cup', 'g', 'metric', {
				gramsPerMl: Dec.from('0.6')
			})?.toString()
		).toBe('150');
		expect(
			convertAmount(Dec.from('300'), 'g', 'ml', 'metric', {
				gramsPerMl: Dec.from('0.6')
			})?.toString()
		).toBe('500');
	});

	it('refuses package units and mismatched dimensions', () => {
		expect(convertAmount(Dec.from('1'), 'can', 'ml', 'metric')).toBeNull();
		expect(convertAmount(Dec.from('1'), 'piece', 'g', 'metric')).toBeNull();
		expect(convertAmount(Dec.from('1'), 'can', 'can', 'metric')?.toString()).toBe('1');
	});
});

describe('formatQuantity', () => {
	it('formats amounts with unit labels and pluralisation', () => {
		expect(formatQuantity(Dec.from('500'), 'g')).toBe('500 g');
		expect(formatQuantity(Dec.from('1'), 'piece')).toBe('1 piece');
		expect(formatQuantity(Dec.from('2'), 'piece')).toBe('2 pieces');
		expect(formatQuantity(Dec.from('1'), 'clove')).toBe('1 clove');
		expect(formatQuantity(Dec.from('3'), 'clove')).toBe('3 cloves');
		expect(formatQuantity(Dec.from('1.333333'), 'cup')).toBe('1.33 cups');
	});
	it('shows an unknown amount as such and a bare number without unit', () => {
		expect(formatQuantity(null, 'g')).toBe('unknown amount');
		expect(formatQuantity(Dec.from('2'), null)).toBe('2');
	});
	it('promotes large metric amounts for readability', () => {
		expect(formatQuantity(Dec.from('1500'), 'g')).toBe('1.5 kg');
		expect(formatQuantity(Dec.from('2000'), 'ml')).toBe('2 l');
		expect(formatQuantity(Dec.from('999'), 'g')).toBe('999 g');
	});
	it('labels units', () => {
		expect(unitLabel('tbsp')).toBe('tbsp');
		expect(unitLabel('piece', 2)).toBe('pieces');
	});
});
