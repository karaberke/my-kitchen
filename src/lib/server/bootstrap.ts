import { eq } from 'drizzle-orm';
import { APIError } from 'better-auth/api';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/schema';
import { serverEnv } from '$lib/server/env';

export type AdminBootstrap =
	| { status: 'skipped' }
	| { status: 'exists'; email: string }
	| { status: 'created'; email: string; userId: string };

/**
 * Creates the account described by ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD when no user
 * with that email exists yet. Runs at every server start and is idempotent: once the
 * account exists the variables are ignored, so a password changed under Settings stays.
 * The database may still be waking up on a cold start, hence the small retry loop.
 */
export interface AdminSpec {
	email: string;
	name: string;
	password: string;
}

export function adminSpecFromEnv(): AdminSpec | null {
	const env = serverEnv();
	if (!env.ADMIN_EMAIL) return null;
	return { email: env.ADMIN_EMAIL, name: env.ADMIN_NAME || 'Admin', password: env.ADMIN_PASSWORD };
}

export async function ensureAdminAccount(
	spec: AdminSpec | null = adminSpecFromEnv(),
	attempts = 5
): Promise<AdminBootstrap> {
	if (!spec) return { status: 'skipped' };
	const email = spec.email.trim().toLowerCase();
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await createIfMissing(email, spec.name, spec.password);
		} catch (err) {
			lastError = err;
			if (err instanceof APIError) break; // validation problems will not fix themselves
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
	console.error(`bootstrap: could not create the ADMIN_EMAIL account (${email})`, lastError);
	return { status: 'skipped' };
}

async function createIfMissing(
	email: string,
	name: string,
	password: string
): Promise<AdminBootstrap> {
	const existing = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email))
		.limit(1);
	if (existing.length) {
		console.log(`bootstrap: account ${email} already exists; ADMIN_PASSWORD is not applied`);
		return { status: 'exists', email };
	}
	try {
		const res = await auth.api.signUpEmail({ body: { name, email, password } });
		console.log(`bootstrap: created account ${email} from ADMIN_EMAIL / ADMIN_PASSWORD`);
		return { status: 'created', email, userId: res.user.id };
	} catch (err) {
		// Two app instances starting at once: the other one won the unique email constraint.
		if (err instanceof APIError && /exist/i.test(err.message)) return { status: 'exists', email };
		throw err;
	}
}
