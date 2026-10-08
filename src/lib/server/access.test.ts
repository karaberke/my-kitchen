import { describe, expect, it } from 'vitest';
import { pickActiveMembership } from './access';

const a = { householdId: 'a' };
const b = { householdId: 'b' };

describe('pickActiveMembership', () => {
	it('keeps the stored preference while the user is a member of it', () => {
		expect(pickActiveMembership([a, b], 'b')).toBe(b);
	});

	it('falls back to the first membership for a stale or missing preference', () => {
		expect(pickActiveMembership([a, b], 'gone')).toBe(a);
		expect(pickActiveMembership([a, b], null)).toBe(a);
	});

	it('is null without memberships', () => {
		expect(pickActiveMembership([], 'a')).toBeNull();
	});
});
