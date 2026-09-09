import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { assertMember, requireHousehold, requireUser } from '$lib/server/access';
import {
	createHousehold,
	createInvite,
	listActiveInvites,
	listMembers,
	otherOwnersExist,
	removeMember,
	renameHousehold,
	revokeInvite,
	setActiveHousehold,
	setMemberRole
} from '$lib/server/households';
import { AppError } from '$lib/server/errors';
import { serverEnv } from '$lib/server/env';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	event.depends('app:household');
	const household = event.locals.household;
	if (!household)
		return { title: 'Household', members: [], invites: [], isOwner: false, canLeave: false };
	const role = await assertMember(db, household.id, user.id);
	const isOwner = role === 'owner';
	const [members, invites, others] = await Promise.all([
		listMembers(db, household.id),
		isOwner ? listActiveInvites(db, household.id) : Promise.resolve([]),
		otherOwnersExist(db, household.id, user.id)
	]);
	return {
		title: 'Household',
		members,
		invites,
		isOwner,
		canLeave: role === 'member' || others,
		origin: serverEnv().ORIGIN
	};
};

function handle(err: unknown) {
	if (err instanceof AppError) return fail(err.status, { message: err.message });
	throw err;
}

export const actions: Actions = {
	switch: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		try {
			await setActiveHousehold(db, user.id, String(fd.get('householdId') ?? ''));
		} catch (err) {
			return handle(err);
		}
		return { ok: true, action: 'switch' };
	},
	create: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		try {
			await createHousehold(db, user.id, String(fd.get('name') ?? ''));
		} catch (err) {
			return handle(err);
		}
		throw redirect(303, '/household');
	},
	rename: async (event) => {
		const { user, household } = requireHousehold(event);
		const fd = await event.request.formData();
		try {
			await renameHousehold(db, user.id, household.id, String(fd.get('name') ?? ''));
		} catch (err) {
			return handle(err);
		}
		return { ok: true, action: 'rename' };
	},
	invite: async (event) => {
		const { user, household } = requireHousehold(event);
		try {
			const inv = await createInvite(db, user.id, household.id);
			return {
				ok: true,
				action: 'invite',
				inviteUrl: `${serverEnv().ORIGIN}/invite/${inv.token}`,
				expiresAt: inv.expiresAt
			};
		} catch (err) {
			return handle(err);
		}
	},
	revoke: async (event) => {
		const { user, household } = requireHousehold(event);
		const fd = await event.request.formData();
		try {
			await revokeInvite(db, user.id, household.id, String(fd.get('inviteId') ?? ''));
		} catch (err) {
			return handle(err);
		}
		return { ok: true, action: 'revoke' };
	},
	role: async (event) => {
		const { user, household } = requireHousehold(event);
		const fd = await event.request.formData();
		const role = fd.get('role') === 'owner' ? 'owner' : 'member';
		try {
			await setMemberRole(user.id, household.id, String(fd.get('userId') ?? ''), role);
		} catch (err) {
			return handle(err);
		}
		return { ok: true, action: 'role' };
	},
	remove: async (event) => {
		const { user, household } = requireHousehold(event);
		const fd = await event.request.formData();
		const target = String(fd.get('userId') ?? '');
		try {
			await removeMember(user.id, household.id, target);
		} catch (err) {
			return handle(err);
		}
		if (target === user.id) throw redirect(303, '/household');
		return { ok: true, action: 'remove' };
	}
};
