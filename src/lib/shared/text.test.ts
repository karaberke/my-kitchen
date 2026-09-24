import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isRfcUuid } from './text';

describe('isRfcUuid', () => {
	it('accepts a generated id in either case', () => {
		expect(isRfcUuid(randomUUID())).toBe(true);
		expect(isRfcUuid('3DA6236D-FD8E-49A7-B7C7-1E7A03F0C824')).toBe(true);
	});

	it('rejects ids without an RFC version and variant, and non-strings', () => {
		expect(isRfcUuid('00000000-0000-0000-0000-000000000000')).toBe(false);
		expect(isRfcUuid('3da6236d-fd8e-09a7-b7c7-1e7a03f0c824')).toBe(false); // version 0
		expect(isRfcUuid('3da6236d-fd8e-49a7-c7c7-1e7a03f0c824')).toBe(false); // variant 110x
		expect(isRfcUuid('3da6236d-fd8e-49a7-b7c7-1e7a03f0c82')).toBe(false);
		expect(isRfcUuid(undefined)).toBe(false);
		expect(isRfcUuid(42)).toBe(false);
	});
});
