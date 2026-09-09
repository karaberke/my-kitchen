import { describe, expect, it } from 'vitest';
import { parseDbTimestamp } from './time';

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
