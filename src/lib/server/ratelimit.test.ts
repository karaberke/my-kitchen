import { beforeEach, describe, expect, it } from 'vitest';
import { consume, resetRateLimits } from './ratelimit';

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
});
