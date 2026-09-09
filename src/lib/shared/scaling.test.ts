import { describe, expect, it } from 'vitest';
import { Dec } from './decimal';
import { scaleAmount, scaleFactor } from './scaling';

describe('scaleAmount', () => {
	it('scales by target/base servings without touching base values', () => {
		const base = Dec.from('300');
		expect(scaleAmount(base, Dec.from('4'), Dec.from('6'))!.toString()).toBe('450');
		expect(scaleAmount(base, Dec.from('4'), Dec.from('2'))!.toString()).toBe('150');
		expect(base.toString()).toBe('300');
	});
	it('handles fractional servings and keeps precision until the end', () => {
		expect(scaleAmount(Dec.from('1'), Dec.from('3'), Dec.from('1'))!.toString()).toBe('0.333333');
		expect(scaleAmount(Dec.from('100'), Dec.from('2.5'), Dec.from('5'))!.toString()).toBe('200');
	});
	it('returns null for unknown amounts', () => {
		expect(scaleAmount(null, Dec.from('4'), Dec.from('8'))).toBeNull();
	});
	it('rejects non-positive servings', () => {
		expect(() => scaleAmount(Dec.from('1'), Dec.zero, Dec.from('1'))).toThrow();
		expect(() => scaleAmount(Dec.from('1'), Dec.from('4'), Dec.from('-1'))).toThrow();
	});
	it('exposes the factor as a human string', () => {
		expect(scaleFactor(Dec.from('4'), Dec.from('6'))).toBe('1.5');
	});
});
