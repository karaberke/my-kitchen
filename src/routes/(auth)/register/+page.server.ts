import { fail, redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoadEvent } from './$types';
import { auth } from '$lib/server/auth';
import { serverEnv } from '$lib/server/env';
import { AUTH_LIMITS, consume } from '$lib/server/ratelimit';

const loadImpl = ({ locals, url }: PageServerLoadEvent) => {
	if (locals.user) throw redirect(303, '/recipes');
	const next = url.searchParams.get('next');
	return {
		title: 'Create account',
		registrationOpen: serverEnv().REGISTRATION_OPEN,
		next: next && next.startsWith('/') && !next.startsWith('//') ? next : '/recipes'
	};
};

export const actions: Actions = {
	default: async (event) => {
		if (!serverEnv().REGISTRATION_OPEN)
			return fail(403, {
				message: 'Registration is closed on this installation.',
				name: '',
				email: ''
			});
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
		if (name.length < 2) return fail(400, { message: 'Enter your name', name, email });
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
			return fail(400, { message: 'Enter a valid email address', name, email });
		if (password.length < 8)
			return fail(400, { message: 'Use at least 8 characters for the password', name, email });
		const limit = consume(`signup:${event.getClientAddress()}`, AUTH_LIMITS.signUp);
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
