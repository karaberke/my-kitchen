import { describe, expect, it } from 'vitest';
import { addDays, isIsoDate, parseDbTimestamp } from './time';

describe('parseDbTimestamp', () => {
	it('parses postgres text timestamps with short offsets', () => {
		expect(parseDbTimestamp('2026-09-09 01:02:03.123456+00').toISOString()).toBe(
			'2026-09-09T01:02:03.123Z'
		);
		expect(parseDbTimestamp('2026-09-09 01:02:03+02').toISOString()).toBe(
			'2026-09-08T23:02:03.000Z'
		);
		expect(parseDbTimestamp('2026-09-09T01:02:03.000Z').toISOString()).toBe(
			'2026-09-09T01:02:03.000Z'
		);
		expect(parseDbTimestamp('2026-09-09 01:02:03').toISOString()).toBe('2026-09-09T01:02:03.000Z');
	});
});

describe('isIsoDate', () => {
	it('accepts a calendar date that exists', () => {
		expect(isIsoDate('2026-02-28')).toBe(true);
		expect(isIsoDate('2028-02-29')).toBe(true);
	});

	it('rejects a date that does not exist, or another format', () => {
		for (const bad of [
			'2026-02-31',
			'2026-02-29',
			'2026-13-01',
			'2026-1-01',
			'01/02/2026',
			'',
			null
		])
			expect(isIsoDate(bad)).toBe(false);
	});
});

describe('addDays', () => {
	it('crosses month and year ends in both directions', () => {
		expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2026-10-08', 0)).toBe('2026-10-08');
	});
});
