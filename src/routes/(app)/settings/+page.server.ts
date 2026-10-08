import { fail, redirect } from '@sveltejs/kit';
import { actionError, guard } from '$lib/server/http';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoadEvent } from './$types';
import { auth, enabledSocialProviders } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { assertMember, requireHousehold, requireUser } from '$lib/server/access';
import { serverEnv } from '$lib/server/env';
import { llmEnabled } from '$lib/server/llm/client';
import { AUTH_LIMITS, consume } from '$lib/server/ratelimit';
import { consistencyCheck } from '$lib/server/pantry';
import { getConvention, setConvention } from '$lib/server/households';
import { PERSON_NAME_MAX_CHARS, cleanText } from '$lib/shared/text';

const loadImpl = async (event: PageServerLoadEvent) => {
	const user = requireUser(event);
	const env = serverEnv();
	const providers = enabledSocialProviders();
	// Which of them this account is already signed in with. Password accounts here
	// are unverified by design (no mail transport), so implicit linking refuses
	// them — linking has to be a deliberate act, which is what this shows.
	const linkedAccounts = async (): Promise<{ id: string; providerId: string }[]> => {
		if (!providers.length) return [];
		try {
			const accounts = await auth.api.listUserAccounts({ headers: event.request.headers });
			return (accounts ?? []).map((a: { id: string; providerId: string }) => ({
				id: a.id,
				providerId: a.providerId
			}));
		} catch {
			return [];
		}
	};
	const [convention, linked] = await Promise.all([getConvention(db, user.id), linkedAccounts()]);
	return {
		title: 'Settings',
		convention,
		providers,
		linked,
		registrationOpen: env.REGISTRATION_OPEN,
		storageBackend: env.STORAGE_BACKEND,
		// pollMs comes from the root layout data.
		aiEnabled: llmEnabled()
	};
};

export const actions: Actions = {
	link: async (event) => {
		requireUser(event);
		const fd = await event.request.formData();
		const provider = String(fd.get('provider') ?? '');
		if (!enabledSocialProviders().includes(provider))
			return fail(400, { message: 'That sign-in method is not available here.' });
		let url: string | null | undefined;
		try {
			const res = await auth.api.linkSocialAccount({
				body: { provider, callbackURL: '/settings' },
				headers: event.request.headers
			});
			url = res?.url;
		} catch (err) {
			if (err instanceof APIError) return fail(400, { message: 'Could not start linking.' });
			throw err;
		}
		if (!url) return fail(400, { message: 'Could not start linking.' });
		throw redirect(303, url);
	},
	unlink: async (event) => {
		requireUser(event);
		const fd = await event.request.formData();
		const accountId = String(fd.get('accountId') ?? '');
		if (!accountId) return fail(400, { message: 'Nothing to remove.' });
		try {
			await auth.api.unlinkAccount({
				body: { accountId },
				headers: event.request.headers
			});
		} catch (err) {
			// Better Auth refuses to remove the last way in, which is exactly right.
			if (err instanceof APIError)
				return fail(400, {
					message: 'That is the only way you can sign in, so it cannot be removed.'
				});
			throw err;
		}
		return { ok: true, form: 'unlink' };
	},
	name: async (event) => {
		requireUser(event);
		const fd = await event.request.formData();
		const name = cleanText(String(fd.get('name') ?? ''), PERSON_NAME_MAX_CHARS);
		if (name.length < 2) return fail(400, { message: 'Enter your name', form: 'name' });
		try {
			await auth.api.updateUser({ body: { name }, headers: event.request.headers });
		} catch (err) {
			if (err instanceof APIError) return fail(400, { message: err.message, form: 'name' });
			throw err;
		}
		return { ok: true, form: 'name' };
	},
	password: async (event) => {
		requireUser(event);
		const fd = await event.request.formData();
		const currentPassword = String(fd.get('currentPassword') ?? '');
		const newPassword = String(fd.get('newPassword') ?? '');
		if (newPassword.length < 8)
			return fail(400, { message: 'Use at least 8 characters', form: 'password' });
		if (newPassword !== String(fd.get('confirm') ?? ''))
			return fail(400, { message: 'The two passwords do not match', form: 'password' });
		const limit = consume(`password:${event.locals.user!.id}`, AUTH_LIMITS.password);
		if (!limit.allowed)
			return fail(429, {
				message: `Too many attempts. Try again in ${limit.retryAfterSeconds} s.`,
				form: 'password'
			});
		try {
			await auth.api.changePassword({
				body: { currentPassword, newPassword, revokeOtherSessions: true },
				headers: event.request.headers
			});
		} catch (err) {
			if (err instanceof APIError)
				return fail(400, {
					message:
						err.statusCode === 429
							? 'Too many attempts. Try again in a minute.'
							: 'Current password is not right',
					form: 'password'
				});
			throw err;
		}
		return { ok: true, form: 'password' };
	},
	convention: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		const convention = fd.get('convention') === 'us' ? 'us' : 'metric';
		await setConvention(db, user.id, convention);
		return { ok: true, form: 'convention' };
	},
	signOut: async (event) => {
		await auth.api.signOut({ headers: event.request.headers }).catch(() => {});
		throw redirect(303, '/login');
	},
	consistency: async (event) => {
		try {
			const { user, household } = requireHousehold(event);
			await assertMember(db, household.id, user.id);
			const report = await consistencyCheck(db, household.id);
			return { ok: true, form: 'consistency', report };
		} catch (err) {
			return actionError(err, 'consistency');
		}
	}
};

export const load = guard(loadImpl);
