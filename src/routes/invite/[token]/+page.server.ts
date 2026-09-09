import { fail, redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { acceptInvite, peekInvite } from '$lib/server/households';
import { AppError } from '$lib/server/errors';
import { serverEnv } from '$lib/server/env';

const loadImpl = async (event: PageServerLoadEvent) => {
	const invite = await peekInvite(db, event.params.token);
	return {
		title: 'Invitation',
		invite: invite ? { householdName: invite.householdName, valid: invite.valid } : null,
		signedIn: !!event.locals.user,
		// A valid invitation may create an account even when sign-ups are closed.
		registrationOpen: serverEnv().REGISTRATION_OPEN || !!invite?.valid,
		next: `/invite/${event.params.token}`
	};
};

export const actions: Actions = {
	default: async (event) => {
		if (!event.locals.user)
			throw redirect(303, `/login?next=${encodeURIComponent(`/invite/${event.params.token}`)}`);
		try {
			await acceptInvite(event.locals.user.id, event.params.token);
		} catch (err) {
			if (err instanceof AppError) return fail(err.status, { message: err.message });
			throw err;
		}
		throw redirect(303, '/household');
	}
};

export const load = guard(loadImpl);
