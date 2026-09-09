import { beforeEach, describe, expect, it } from 'vitest';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { ensureAdminAccount } from '$lib/server/bootstrap';
import { createInvite, listMemberships, revokeInvite } from '$lib/server/households';
import { inviteTokenFromPath, registrationAllowed } from '$lib/server/registration';
import { createUser, resetDb } from './helpers';

describe('account bootstrap and registration policy', () => {
	beforeEach(resetDb);

	it('creates the ADMIN_* account once with its household and a working password', async () => {
		const spec = { email: 'Owner@Example.test', name: 'Owner', password: 'first-password' };
		const first = await ensureAdminAccount(spec);
		expect(first.status).toBe('created');
		if (first.status !== 'created') throw new Error('unreachable');
		const memberships = await listMemberships(db, first.userId);
		expect(memberships).toHaveLength(1);
		expect(memberships[0].role).toBe('owner');
		const signIn = await auth.api.signInEmail({
			body: { email: 'owner@example.test', password: 'first-password' }
		});
		expect(signIn.user.id).toBe(first.userId);

		// A second start with a different password must not touch the existing account.
		const second = await ensureAdminAccount({ ...spec, password: 'changed-later' });
		expect(second.status).toBe('exists');
		await expect(
			auth.api.signInEmail({ body: { email: 'owner@example.test', password: 'changed-later' } })
		).rejects.toThrow();
		const again = await auth.api.signInEmail({
			body: { email: 'owner@example.test', password: 'first-password' }
		});
		expect(again.user.id).toBe(first.userId);
	});

	it('lets a valid invitation link create an account while sign-ups are closed', async () => {
		const alice = await createUser('Alice');
		const invite = await createInvite(db, alice.id, alice.householdId);
		const next = `/invite/${invite.token}`;
		expect(inviteTokenFromPath(next)).toBe(invite.token);
		expect(await registrationAllowed(db, '/recipes', false)).toBe(false);
		expect(await registrationAllowed(db, next, false)).toBe(true);
		expect(await registrationAllowed(db, '/recipes', true)).toBe(true);
		await revokeInvite(db, alice.id, alice.householdId, invite.id);
		expect(await registrationAllowed(db, next, false)).toBe(false);
		expect(await registrationAllowed(db, '/invite/not-a-real-token-value', false)).toBe(false);
	});
});
