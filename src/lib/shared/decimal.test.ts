import { describe, expect, it } from 'vitest';
import { Dec } from './decimal';

describe('Dec fixed-point decimal', () => {
	it('parses plain decimal strings and prints canonical form', () => {
		expect(Dec.from('12').toString()).toBe('12');
		expect(Dec.from('12.500000').toString()).toBe('12.5');
		expect(Dec.from('-0.25').toString()).toBe('-0.25');
		expect(Dec.from('.5').toString()).toBe('0.5');
		expect(Dec.from('0').toString()).toBe('0');
		expect(Dec.from('-0').toString()).toBe('0');
	});

	it('parses numbers without binary drift', () => {
		expect(Dec.from(0.1).add(Dec.from(0.2)).toString()).toBe('0.3');
		expect(Dec.from(1.5).toString()).toBe('1.5');
	});

	it('rejects invalid input', () => {
		expect(() => Dec.from('abc')).toThrow();
		expect(() => Dec.from('')).toThrow();
		expect(() => Dec.from('1.2.3')).toThrow();
		expect(() => Dec.from(NaN)).toThrow();
		expect(() => Dec.from(Infinity)).toThrow();
	});

	it('rounds input beyond six decimals half away from zero', () => {
		expect(Dec.from('0.0000005').toString()).toBe('0.000001');
		expect(Dec.from('0.0000004').toString()).toBe('0');
		expect(Dec.from('-0.0000005').toString()).toBe('-0.000001');
	});

	it('adds, subtracts and compares exactly', () => {
		const a = Dec.from('500');
		const b = Dec.from('300');
		expect(a.add(b).toString()).toBe('800');
		expect(a.sub(b).toString()).toBe('200');
		expect(b.sub(a).toString()).toBe('-200');
		expect(a.cmp(b)).toBe(1);
		expect(b.cmp(a)).toBe(-1);
		expect(a.cmp(Dec.from('500.0'))).toBe(0);
		expect(a.eq(Dec.from(500))).toBe(true);
		expect(a.gt(b)).toBe(true);
		expect(b.lt(a)).toBe(true);
		expect(a.gte(a)).toBe(true);
	});

	it('multiplies by decimals and by rationals with rounding only at the end', () => {
		expect(Dec.from('300').mul(Dec.from('1.5')).toString()).toBe('450');
		expect(Dec.from('300').mulRatio(3, 4).toString()).toBe('225');
		// 100 * 1/3 = 33.333333 at scale 6
		expect(Dec.from('100').mulRatio(1, 3).toString()).toBe('33.333333');
		expect(Dec.from('14.7868').mul(Dec.from('3')).toString()).toBe('44.3604');
	});

	it('divides with scale-6 rounding', () => {
		expect(Dec.from('1000').div(Dec.from('1000')).toString()).toBe('1');
		expect(Dec.from('1').div(Dec.from('3')).toString()).toBe('0.333333');
		expect(Dec.from('2').div(Dec.from('3')).toString()).toBe('0.666667');
		expect(() => Dec.from('1').div(Dec.zero)).toThrow();
	});

	it('provides max, min, zero and sign checks', () => {
		expect(Dec.max(Dec.from('-5'), Dec.zero).toString()).toBe('0');
		expect(Dec.min(Dec.from('2'), Dec.from('3')).toString()).toBe('2');
		expect(Dec.from('-1').isNegative()).toBe(true);
		expect(Dec.zero.isZero()).toBe(true);
		expect(Dec.from('0.000001').isPositive()).toBe(true);
	});

	it('formats to a fixed number of decimals for display, rounding half away from zero', () => {
		expect(Dec.from('33.333333').toFixed(2)).toBe('33.33');
		expect(Dec.from('0.125').toFixed(2)).toBe('0.13');
		expect(Dec.from('-0.125').toFixed(2)).toBe('-0.13');
		expect(Dec.from('2').toFixed(2)).toBe('2.00');
	});

	it('formats for humans by trimming zeros to at most two decimals', () => {
		expect(Dec.from('2').toHuman()).toBe('2');
		expect(Dec.from('2.5').toHuman()).toBe('2.5');
		expect(Dec.from('33.333333').toHuman()).toBe('33.33');
		expect(Dec.from('0.004').toHuman()).toBe('0');
	});

	it('serialises to a plain string for JSON and database boundaries', () => {
		expect(JSON.stringify({ q: Dec.from('1.25') })).toBe('{"q":"1.25"}');
		expect(Dec.from('1.250000').toDb()).toBe('1.250000');
	});

	it('sums a list', () => {
		expect(Dec.sum([Dec.from('1'), Dec.from('2.5'), Dec.from('-0.5')]).toString()).toBe('3');
		expect(Dec.sum([]).toString()).toBe('0');
	});
});
