import { fail, redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoadEvent } from './$types';
import { auth } from '$lib/server/auth';
import { serverEnv } from '$lib/server/env';
import { AUTH_LIMITS, consume } from '$lib/server/ratelimit';

function safeNext(raw: string | null): string {
	return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/recipes';
}

const loadImpl = ({ locals, url }: PageServerLoadEvent) => {
	if (locals.user) throw redirect(303, safeNext(url.searchParams.get('next')));
	return {
		title: 'Sign in',
		registrationOpen: serverEnv().REGISTRATION_OPEN,
		next: safeNext(url.searchParams.get('next'))
	};
};

export const actions: Actions = {
	default: async (event) => {
		const fd = await event.request.formData();
		const email = String(fd.get('email') ?? '')
			.trim()
			.slice(0, 200);
		const password = String(fd.get('password') ?? '').slice(0, 200);
		const next = safeNext(String(fd.get('next') ?? ''));
		if (!email || !password) return fail(400, { message: 'Enter your email and password', email });
		const limit = consume(`signin:${event.getClientAddress()}:${email.toLowerCase()}`, AUTH_LIMITS.signIn);
		if (!limit.allowed) return fail(429, { message: `Too many attempts. Try again in ${limit.retryAfterSeconds} s.`, email });
		try {
			await auth.api.signInEmail({ body: { email, password }, headers: event.request.headers });
		} catch (err) {
			if (err instanceof APIError)
				return fail(err.statusCode === 429 ? 429 : 400, {
					message:
						err.statusCode === 429
							? 'Too many attempts. Wait a minute and try again.'
							: 'Email or password is not right',
					email
				});
			throw err;
		}
		throw redirect(303, next);
	}
};

export const load = guard(loadImpl);
