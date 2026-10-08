import { beforeEach, describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, PROVIDER_LIMITS, consume, resetRateLimits } from './ratelimit';

describe('consume', () => {
	beforeEach(resetRateLimits);
	it('allows up to max hits within the window, then rejects with a retry hint', () => {
		const rule = { windowMs: 60_000, max: 3 };
		expect(consume('k', rule, 0).allowed).toBe(true);
		expect(consume('k', rule, 1000).allowed).toBe(true);
		expect(consume('k', rule, 2000).allowed).toBe(true);
		const denied = consume('k', rule, 3000);
		expect(denied.allowed).toBe(false);
		expect(denied.retryAfterSeconds).toBe(57);
		expect(consume('other', rule, 3000).allowed).toBe(true);
		expect(consume('k', rule, 61_000).allowed).toBe(true);
	});

	it('keeps an hour-long bucket through the periodic sweep until its own window ends', () => {
		const rule = { windowMs: PROVIDER_LIMITS.usda.windowMs, max: 2 };
		const start = 10 * 60_000;
		expect(consume('usda', rule, start).allowed).toBe(true);
		expect(consume('usda', rule, start + 1).allowed).toBe(true);
		// Twenty minutes later another key triggers the sweep; the hourly count must survive it.
		const later = start + 20 * 60_000;
		expect(consume('other', { windowMs: 60_000, max: 1 }, later).allowed).toBe(true);
		expect(consume('usda', rule, later).allowed).toBe(false);
		expect(consume('usda', rule, start + rule.windowMs + 1).allowed).toBe(true);
	});
});

describe('IMPORT_LIMITS', () => {
	beforeEach(resetRateLimits);
	it('allows ten URL imports a minute for one user, then rejects', () => {
		const rule = IMPORT_LIMITS.fetch;
		for (let i = 0; i < 10; i++) expect(consume('import:u1', rule, i).allowed).toBe(true);
		expect(consume('import:u1', rule, 10).allowed).toBe(false);
		// The bucket is per user: a second cook is unaffected.
		expect(consume('import:u2', rule, 10).allowed).toBe(true);
	});
});
