import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/access';
import { serverEnv } from '$lib/server/env';
import { consistencyCheck } from '$lib/server/pantry';
import { eq } from 'drizzle-orm';
import { userPreferences } from '$lib/server/db/schema';
import { sql } from 'drizzle-orm';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const [pref] = await db
		.select({ convention: userPreferences.convention })
		.from(userPreferences)
		.where(eq(userPreferences.userId, user.id))
		.limit(1);
	const env = serverEnv();
	return {
		title: 'Settings',
		convention: pref?.convention ?? 'metric',
		registrationOpen: env.REGISTRATION_OPEN,
		storageBackend: env.STORAGE_BACKEND,
		pollMs: Number(process.env.PUBLIC_REVISION_POLL_MS ?? 20000)
	};
};

export const actions: Actions = {
	name: async (event) => {
		requireUser(event);
		const fd = await event.request.formData();
		const name = String(fd.get('name') ?? '')
			.trim()
			.replace(/\s+/g, ' ')
			.slice(0, 80);
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
		await db
			.insert(userPreferences)
			.values({ userId: user.id, convention })
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { convention, updatedAt: sql`now()` }
			});
		return { ok: true, form: 'convention' };
	},
	signOut: async (event) => {
		await auth.api.signOut({ headers: event.request.headers }).catch(() => {});
		throw redirect(303, '/login');
	},
	consistency: async (event) => {
		requireUser(event);
		const household = event.locals.household;
		if (!household) return fail(400, { message: 'No household', form: 'consistency' });
		const report = await consistencyCheck(db, household.id);
		return { ok: true, form: 'consistency', report };
	}
};
