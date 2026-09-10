import { fail, redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { acceptInvite, peekInvite } from '$lib/server/households';
import { AppError } from '$lib/server/errors';
import { serverEnv } from '$lib/server/env';
import { INVITE_COOKIE } from '$lib/server/registration';

const loadImpl = async (event: PageServerLoadEvent) => {
	const invite = await peekInvite(db, event.params.token);
	// A social sign-in leaves the app and comes back through the provider's callback,
	// which carries none of this URL. Park the token briefly so the callback can still
	// tell that this person was invited.
	if (invite?.valid) {
		event.cookies.set(INVITE_COOKIE, event.params.token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: event.url.protocol === 'https:',
			maxAge: 60 * 30
		});
	}
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
		let householdId: string;
		try {
			householdId = await acceptInvite(event.locals.user.id, event.params.token);
		} catch (err) {
			if (err instanceof AppError) return fail(err.status, { message: err.message });
			throw err;
		}
		event.cookies.delete(INVITE_COOKIE, { path: '/' });
		// Land on the household just joined, not the bare list.
		throw redirect(303, `/household/${householdId}`);
	}
};

export const load = guard(loadImpl);
