import { fail, redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoadEvent } from './$types';
import { auth, enabledSocialProviders } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { registrationAllowed } from '$lib/server/registration';
import { AUTH_LIMITS, clientKey, consume } from '$lib/server/ratelimit';

const loadImpl = async ({ locals, url }: PageServerLoadEvent) => {
	if (locals.user) throw redirect(303, '/recipes');
	const raw = url.searchParams.get('next');
	const next = raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/recipes';
	return {
		title: 'Create account',
		registrationOpen: await registrationAllowed(db, next),
		// Only offered when this visitor may create an account, so the buttons never
		// promise something the sign-up gate will refuse.
		providers: (await registrationAllowed(db, next)) ? enabledSocialProviders() : [],
		next
	};
};

export const actions: Actions = {
	social: async (event) => {
		const fd = await event.request.formData();
		const nextRaw = String(fd.get('next') ?? '');
		const next = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/recipes';
		const provider = String(fd.get('provider') ?? '');
		if (!enabledSocialProviders().includes(provider) || !(await registrationAllowed(db, next)))
			return fail(400, { message: 'That sign-in method is not available here.' });
		let url: string | null | undefined;
		try {
			const res = await auth.api.signInSocial({
				body: { provider, callbackURL: next },
				headers: event.request.headers
			});
			url = res?.url;
		} catch {
			return fail(400, { message: 'Could not start that sign-in.' });
		}
		if (!url) return fail(400, { message: 'Could not start that sign-in.' });
		throw redirect(303, url);
	},
	signup: async (event) => {
		const fd = await event.request.formData();
		const name = String(fd.get('name') ?? '')
			.trim()
			.replace(/\s+/g, ' ')
			.slice(0, 80);
		const email = String(fd.get('email') ?? '')
			.trim()
			.slice(0, 200);
		const password = String(fd.get('password') ?? '').slice(0, 200);
		const nextRaw = String(fd.get('next') ?? '');
		const next = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/recipes';
		if (!(await registrationAllowed(db, next)))
			return fail(403, {
				message: 'Registration is closed on this installation.',
				name,
				email
			});
		if (name.length < 2) return fail(400, { message: 'Enter your name', name, email });
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
			return fail(400, { message: 'Enter a valid email address', name, email });
		if (password.length < 8)
			return fail(400, { message: 'Use at least 8 characters for the password', name, email });
		const limit = consume(`signup:${clientKey(event)}`, AUTH_LIMITS.signUp);
		if (!limit.allowed)
			return fail(429, {
				message: `Too many attempts. Try again in ${limit.retryAfterSeconds} s.`,
				name,
				email
			});
		try {
			await auth.api.signUpEmail({
				body: { name, email, password },
				headers: event.request.headers
			});
		} catch (err) {
			if (err instanceof APIError) {
				const msg =
					err.statusCode === 429
						? 'Too many attempts. Wait a minute and try again.'
						: err.message.includes('exist')
							? 'An account with this email already exists'
							: err.message;
				return fail(400, { message: msg, name, email });
			}
			throw err;
		}
		throw redirect(303, next);
	}
};

export const load = guard(loadImpl);
