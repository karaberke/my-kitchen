import { describe, expect, it } from 'vitest';
import { parseAmount } from './amount-parse';

const ok = (s: string) => {
	const r = parseAmount(s);
	if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(s)}: ${r.error}`);
	return r.value === null ? null : r.value.toString();
};

describe('parseAmount', () => {
	it('treats blank input as unknown, distinct from zero', () => {
		expect(ok('')).toBeNull();
		expect(ok('   ')).toBeNull();
		expect(ok('0')).toBe('0');
	});

	it('parses integers and decimals', () => {
		expect(ok('2')).toBe('2');
		expect(ok('2.5')).toBe('2.5');
		expect(ok('.75')).toBe('0.75');
		expect(ok(' 12 ')).toBe('12');
	});

	it('accepts a comma decimal separator when unambiguous', () => {
		expect(ok('1,5')).toBe('1.5');
		expect(parseAmount('1,000.5').ok).toBe(false);
	});

	it('parses simple and mixed ASCII fractions', () => {
		expect(ok('1/2')).toBe('0.5');
		expect(ok('1 1/2')).toBe('1.5');
		expect(ok('3/4')).toBe('0.75');
		expect(ok('2 3/4')).toBe('2.75');
		expect(ok('1/3')).toBe('0.333333');
	});

	it('parses unicode vulgar fractions, alone or attached to a whole number', () => {
		expect(ok('½')).toBe('0.5');
		expect(ok('1½')).toBe('1.5');
		expect(ok('1 ½')).toBe('1.5');
		expect(ok('¼')).toBe('0.25');
		expect(ok('¾')).toBe('0.75');
		expect(ok('⅓')).toBe('0.333333');
		expect(ok('⅔')).toBe('0.666667');
		expect(ok('⅛')).toBe('0.125');
		expect(ok('2⅓')).toBe('2.333333');
	});

	it('rejects negatives, zero denominators and garbage', () => {
		expect(parseAmount('-1').ok).toBe(false);
		expect(parseAmount('1/0').ok).toBe(false);
		expect(parseAmount('abc').ok).toBe(false);
		expect(parseAmount('1 2').ok).toBe(false);
		expect(parseAmount('1/2/3').ok).toBe(false);
		expect(parseAmount('1e5').ok).toBe(false);
	});

	it('rejects absurdly large values', () => {
		expect(parseAmount('100000000000').ok).toBe(false);
	});
});
