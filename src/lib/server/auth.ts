import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';
import { serverEnv, isProduction } from '$lib/server/env';
import { ensurePersonalHousehold } from '$lib/server/households';

const env = serverEnv();

/**
 * Better Auth with database sessions. Cookie caching stays disabled so that a
 * revoked session is rejected on the very next request.
 */
export const auth = betterAuth({
	baseURL: env.ORIGIN,
	secret: env.BETTER_AUTH_SECRET,
	trustedOrigins: [env.ORIGIN],
	database: drizzleAdapter(db, { provider: 'pg' }),
	emailAndPassword: {
		enabled: true,
		disableSignUp: !env.REGISTRATION_OPEN,
		minPasswordLength: 8,
		maxPasswordLength: 128,
		// No email transport is configured, so password reset is intentionally off.
		requireEmailVerification: false
	},
	session: {
		expiresIn: 60 * 60 * 24 * 30,
		updateAge: 60 * 60 * 24,
		cookieCache: { enabled: false }
	},
	rateLimit: {
		enabled: true,
		window: 60,
		max: 30,
		customRules: {
			'/sign-in/email': { window: 60, max: 8 },
			'/sign-up/email': { window: 60, max: 5 },
			'/change-password': { window: 60, max: 5 }
		}
	},
	advanced: {
		useSecureCookies: isProduction(),
		cookiePrefix: 'pp'
	},
	databaseHooks: {
		user: {
			create: {
				after: async (user) => {
					await ensurePersonalHousehold(db, user.id, user.name);
				}
			}
		}
	},
	plugins: [
		// Last plugin in the array. Outside a request (scripts, tests) there is no
		// event to set cookies on, so the lookup degrades to a no-op.
		sveltekitCookies(() => {
			try {
				return getRequestEvent();
			} catch {
				return undefined as unknown as ReturnType<typeof getRequestEvent>;
			}
		})
	]
});

export type Auth = typeof auth;
