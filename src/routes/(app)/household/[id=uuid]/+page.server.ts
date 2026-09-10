import { fail, redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent, RequestEvent } from './$types';
import { db } from '$lib/server/db';
import { assertMember, loadHouseholdOrThrow, requireUser } from '$lib/server/access';
import {
	createInvite,
	deleteHousehold,
	ensurePersonalHousehold,
	listActiveInvites,
	listMembers,
	listMemberships,
	otherOwnersExist,
	removeMember,
	renameHousehold,
	revokeInvite,
	setMemberRole
} from '$lib/server/households';
import { asAppError } from '$lib/server/errors';
import { serverEnv } from '$lib/server/env';
import { requestOrigin } from '$lib/server/auth';

/**
 * Manage one household — not necessarily the active one. The id comes from the URL,
 * so the load and every action authorise against it rather than event.locals.household.
 */
const loadImpl = async (event: PageServerLoadEvent) => {
	const user = requireUser(event);
	event.depends('app:household');
	const householdId = event.params.id;
	const role = await assertMember(db, householdId, user.id);
	const isOwner = role === 'owner';
	const [household, members, invites, others] = await Promise.all([
		loadHouseholdOrThrow(db, householdId),
		listMembers(db, householdId),
		isOwner ? listActiveInvites(db, householdId) : Promise.resolve([]),
		otherOwnersExist(db, householdId, user.id)
	]);
	return {
		title: household.name,
		managed: { id: householdId, name: household.name, role },
		members,
		invites,
		isOwner,
		canLeave: role === 'member' || others,
		origin: inviteBase(event)
	};
};

/**
 * Absolute base for an invitation link. ORIGIN is empty in auto-origin mode (the
 * Cloudflare quick tunnel, whose hostname is not known in advance), which used
 * to yield a bare "/invite/<token>" — a link nobody could follow once pasted
 * into a message. Fall back to the origin the request actually arrived on.
 */
function inviteBase(event: RequestEvent): string {
	return serverEnv().ORIGIN || requestOrigin(event.request) || event.url.origin;
}

function handle(err: unknown) {
	const app = asAppError(err);
	if (app) return fail(app.status, { message: app.message });
	throw err;
}

/** Every action re-checks membership itself; the domain helpers assert owner where needed. */
function actor(event: RequestEvent) {
	return { user: requireUser(event), householdId: event.params.id };
}

export const actions: Actions = {
	rename: async (event) => {
		const { user, householdId } = actor(event);
		const fd = await event.request.formData();
		try {
			await renameHousehold(db, user.id, householdId, String(fd.get('name') ?? ''));
		} catch (err) {
			return handle(err);
		}
		return { ok: true, action: 'rename' };
	},
	invite: async (event) => {
		const { user, householdId } = actor(event);
		try {
			const inv = await createInvite(db, user.id, householdId);
			return {
				ok: true,
				action: 'invite',
				inviteUrl: `${inviteBase(event)}/invite/${inv.token}`,
				expiresAt: inv.expiresAt
			};
		} catch (err) {
			return handle(err);
		}
	},
	revoke: async (event) => {
		const { user, householdId } = actor(event);
		const fd = await event.request.formData();
		try {
			await revokeInvite(db, user.id, householdId, String(fd.get('inviteId') ?? ''));
		} catch (err) {
			return handle(err);
		}
		return { ok: true, action: 'revoke' };
	},
	role: async (event) => {
		const { user, householdId } = actor(event);
		const fd = await event.request.formData();
		const role = fd.get('role') === 'owner' ? 'owner' : 'member';
		try {
			await setMemberRole(user.id, householdId, String(fd.get('userId') ?? ''), role);
		} catch (err) {
			return handle(err);
		}
		return { ok: true, action: 'role' };
	},
	remove: async (event) => {
		const { user, householdId } = actor(event);
		const fd = await event.request.formData();
		const target = String(fd.get('userId') ?? '');
		try {
			await removeMember(user.id, householdId, target);
		} catch (err) {
			return handle(err);
		}
		// Leaving means losing access to this page.
		if (target === user.id) throw redirect(303, '/household');
		return { ok: true, action: 'remove' };
	},
	deleteHousehold: async (event) => {
		const { user, householdId } = actor(event);
		const fd = await event.request.formData();
		const confirmName = String(fd.get('confirmName') ?? '').trim();
		try {
			// Authorise before anything else, so a non-member learns nothing about this household.
			await assertMember(db, householdId, user.id);
			const household = await loadHouseholdOrThrow(db, householdId);
			if (confirmName !== household.name)
				return fail(400, { message: 'Type the household name exactly to confirm.' });
			await deleteHousehold(user.id, householdId);
			// Never leave the user with zero households: give them a fresh personal kitchen.
			const remaining = await listMemberships(db, user.id);
			if (remaining.length === 0) await ensurePersonalHousehold(db, user.id, user.name);
		} catch (err) {
			return handle(err);
		}
		throw redirect(303, '/household');
	}
};

export const load = guard(loadImpl);
