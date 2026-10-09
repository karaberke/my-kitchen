import { fail, redirect } from '@sveltejs/kit';
import { formText, guard, safeNext } from '$lib/server/http';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoadEvent } from './$types';
import { auth, enabledSocialProviders } from '$lib/server/auth';
import { serverEnv } from '$lib/server/env';
import {
	AUTH_LIMITS,
	TOO_MANY_ATTEMPTS_WAIT,
	clientKey,
	consume,
	tooManyAttempts
} from '$lib/server/ratelimit';

export const load = guard(({ locals, url }: PageServerLoadEvent) => {
	if (locals.user) throw redirect(303, safeNext(url.searchParams.get('next')));
	return {
		title: 'Sign in',
		registrationOpen: serverEnv().REGISTRATION_OPEN,
		providers: enabledSocialProviders(),
		next: safeNext(url.searchParams.get('next'))
	};
});

export const actions: Actions = {
	social: async (event) => {
		const fd = await event.request.formData();
		const provider = formText(fd, 'provider');
		if (!enabledSocialProviders().includes(provider))
			return fail(400, { message: 'That sign-in method is not available here.' });
		let url: string | null | undefined;
		try {
			const res = await auth.api.signInSocial({
				body: { provider, callbackURL: safeNext(formText(fd, 'next')) },
				headers: event.request.headers
			});
			url = res?.url;
		} catch (err) {
			if (err instanceof APIError) return fail(400, { message: 'Could not start that sign-in.' });
			throw err;
		}
		if (!url) return fail(400, { message: 'Could not start that sign-in.' });
		throw redirect(303, url);
	},
	signin: async (event) => {
		const fd = await event.request.formData();
		const email = formText(fd, 'email').trim().slice(0, 200);
		const password = formText(fd, 'password').slice(0, 200);
		const next = safeNext(formText(fd, 'next'));
		if (!email || !password) return fail(400, { message: 'Enter your email and password', email });
		const limit = consume(`signin:${clientKey(event)}:${email.toLowerCase()}`, AUTH_LIMITS.signIn);
		if (!limit.allowed)
			return fail(429, {
				message: tooManyAttempts(limit.retryAfterSeconds),
				email
			});
		try {
			await auth.api.signInEmail({ body: { email, password }, headers: event.request.headers });
		} catch (err) {
			if (err instanceof APIError)
				return fail(err.statusCode === 429 ? 429 : 400, {
					message:
						err.statusCode === 429 ? TOO_MANY_ATTEMPTS_WAIT : 'Email or password is not right',
					email
				});
			throw err;
		}
		throw redirect(303, next);
	}
};
