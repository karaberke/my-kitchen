import { describe, expect, it } from 'vitest';
import { Dec } from './decimal';
import {
	packageSizeSuggestion,
	pantryAmount,
	parsePackageSizeText,
	type PackageSizeSuggestion
} from './package-size';

const shown = (s: PackageSizeSuggestion) =>
	s.size ? `${s.size.amount.toString()} ${s.size.unit}` : null;

describe('parsePackageSizeText', () => {
	it('reads a plain net-contents statement', () => {
		expect(shown(parsePackageSizeText('397 g'))).toBe('397 g');
		expect(shown(parsePackageSizeText('500g'))).toBe('500 g');
		expect(shown(parsePackageSizeText('1.5 L'))).toBe('1.5 l');
		expect(shown(parsePackageSizeText('1,5 l'))).toBe('1.5 l');
	});

	it('keeps ounces and fluid ounces apart', () => {
		expect(shown(parsePackageSizeText('16 oz'))).toBe('16 oz');
		expect(shown(parsePackageSizeText('16 fl oz'))).toBe('16 fl_oz');
		expect(shown(parsePackageSizeText('16 fl. oz.'))).toBe('16 fl_oz');
		expect(shown(parsePackageSizeText('16 fluid ounces'))).toBe('16 fl_oz');
	});

	it('accepts one quantity printed twice', () => {
		expect(shown(parsePackageSizeText('Net Wt 9.5 oz (269 g)'))).toBe('9.5 oz');
		expect(shown(parsePackageSizeText('16.9 fl oz (500 ml)'))).toBe('16.9 fl_oz');
	});

	it('returns unknown rather than add two different amounts', () => {
		const r = parsePackageSizeText('1 lb 8 oz');
		expect(r.size).toBeNull();
		expect(r.reason).toBe('conflicting_amounts');
	});

	it('reads a club-store multipack as a size and a package count', () => {
		const r = parsePackageSizeText('12 x 330 ml');
		expect(shown(r)).toBe('330 ml');
		expect(r.packagesInLabel).toBe(12);
		const t = parsePackageSizeText('1.5 L x 6');
		expect(shown(t)).toBe('1.5 l');
		expect(t.packagesInLabel).toBe(6);
	});

	it('returns unknown, never zero, when it understands nothing', () => {
		expect(parsePackageSizeText('').reason).toBe('absent');
		expect(parsePackageSizeText('   ').reason).toBe('absent');
		expect(parsePackageSizeText('family size').reason).toBe('unparsed');
		expect(parsePackageSizeText('12 count').reason).toBe('unsupported_unit');
		expect(parsePackageSizeText('1 bag').reason).toBe('unsupported_unit');
		expect(parsePackageSizeText('family size').size).toBeNull();
	});

	it('preserves the label text whatever it understood', () => {
		expect(parsePackageSizeText(' Net Wt 9.5 oz ').labelText).toBe('Net Wt 9.5 oz');
		expect(parsePackageSizeText(' family size ').labelText).toBe('family size');
	});
});

describe('packageSizeSuggestion', () => {
	it('prefers the structured fields a provider supplies', () => {
		const r = packageSizeSuggestion({ amount: Dec.from('397'), unit: 'g' }, '14 oz');
		expect(shown(r)).toBe('397 g');
		expect(r.source).toBe('structured');
		expect(r.labelText).toBe('14 oz');
	});

	it('falls back to the label text when the structured fields are unusable', () => {
		expect(packageSizeSuggestion({ amount: null, unit: 'g' }, '397 g').source).toBe('label_text');
		expect(packageSizeSuggestion({ amount: Dec.zero, unit: 'g' }, '397 g').source).toBe(
			'label_text'
		);
		expect(packageSizeSuggestion({ amount: Dec.from('1'), unit: 'bag' }, '397 g').source).toBe(
			'label_text'
		);
	});

	it('reports unknown when the provider gave neither', () => {
		const r = packageSizeSuggestion(null, '');
		expect(r.size).toBeNull();
		expect(r.source).toBe('unknown');
	});
});

describe('pantryAmount', () => {
	it('multiplies the package size by the package count', () => {
		const r = pantryAmount({ amount: Dec.from('500'), unit: 'g' }, 2);
		expect(r.ok && r.quantity.toString()).toBe('1000');
		expect(r.ok && r.unit).toBe('g');
	});

	it('keeps one package as one package', () => {
		const r = pantryAmount({ amount: Dec.from('1.5'), unit: 'l' }, 1);
		expect(r.ok && r.quantity.toString()).toBe('1.5');
	});

	it('handles a club-store multipack', () => {
		const r = pantryAmount({ amount: Dec.from('330'), unit: 'ml' }, 12);
		expect(r.ok && r.quantity.toString()).toBe('3960');
	});

	it('refuses a count that is not a whole number of packages', () => {
		expect(pantryAmount({ amount: Dec.from('500'), unit: 'g' }, 0).ok).toBe(false);
		expect(pantryAmount({ amount: Dec.from('500'), unit: 'g' }, 2.5).ok).toBe(false);
		expect(pantryAmount({ amount: Dec.from('500'), unit: 'g' }, 1000).ok).toBe(false);
	});

	it('refuses an unusable package size', () => {
		expect(pantryAmount({ amount: Dec.zero, unit: 'g' }, 1).ok).toBe(false);
		expect(pantryAmount({ amount: Dec.from('1'), unit: 'nonsense' }, 1).ok).toBe(false);
	});
});
