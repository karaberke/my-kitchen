import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import {
	INVITE_COOKIE,
	inviteTokenFromCookie,
	socialSignUpAllowed
} from '$lib/server/registration';
import { createInvite, revokeInvite } from '$lib/server/households';
import { createUser, resetDb } from './helpers';

const req = (cookie?: string) =>
	new Request('https://kitchen.example/api/auth/callback/google', {
		headers: cookie ? { cookie } : {}
	});

describe('inviteTokenFromCookie', () => {
	it('finds the token among other cookies', () => {
		const t = 'a'.repeat(32);
		expect(inviteTokenFromCookie(`mk.session=x; ${INVITE_COOKIE}=${t}; other=y`)).toBe(t);
	});

	it('refuses anything that is not shaped like a token', () => {
		expect(inviteTokenFromCookie(null)).toBeNull();
		expect(inviteTokenFromCookie('unrelated=1')).toBeNull();
		expect(inviteTokenFromCookie(`${INVITE_COOKIE}=short`)).toBeNull();
		expect(inviteTokenFromCookie(`${INVITE_COOKIE}=has spaces and ; junk`)).toBeNull();
	});
});

describe('socialSignUpAllowed', () => {
	beforeEach(resetDb);

	it('lets anyone in while registration is open', async () => {
		expect(await socialSignUpAllowed(db, req(), true)).toBe(true);
		expect(await socialSignUpAllowed(db, null, true)).toBe(true);
	});

	it('refuses a stranger when registration is closed', async () => {
		// This is the hole social sign-in would otherwise open: no /register action
		// runs, so without the gate the callback would create the account anyway.
		expect(await socialSignUpAllowed(db, req(), false)).toBe(false);
		expect(await socialSignUpAllowed(db, null, false)).toBe(false);
	});

	it('lets an invited person in while closed, and stops once the invite is spent', async () => {
		const alice = await createUser('Alice');
		const invite = await createInvite(db, alice.id, alice.householdId);
		const cookie = `${INVITE_COOKIE}=${invite.token}`;

		expect(await socialSignUpAllowed(db, req(cookie), false)).toBe(true);

		await revokeInvite(db, alice.id, alice.householdId, invite.id);
		expect(await socialSignUpAllowed(db, req(cookie), false)).toBe(false);
	});

	it('refuses a forged or unknown token', async () => {
		const cookie = `${INVITE_COOKIE}=${'z'.repeat(40)}`;
		expect(await socialSignUpAllowed(db, req(cookie), false)).toBe(false);
	});
});
