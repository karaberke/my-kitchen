import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { dev } from '$app/environment';
import { db } from '$lib/server/db';
import { serverEnv } from '$lib/server/env';
import { ensurePersonalHousehold } from '$lib/server/households';

const env = serverEnv();
const fixedOrigin = env.ORIGIN || null;

/**
 * Origin of the current request as seen through a reverse proxy or tunnel.
 * Used only when ORIGIN is empty ("auto" mode, e.g. a Cloudflare quick tunnel
 * whose hostname is not known in advance). Cross-site requests still fail the
 * check because their Origin header differs from the Host they target.
 */
export function requestOrigin(request: Request): string | null {
	const proto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() || 'https';
	const host =
		request.headers.get('x-forwarded-host')?.split(',')[0].trim() || request.headers.get('host');
	if (!host || !/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) || !/^https?$/.test(proto)) return null;
	return `${proto}://${host}`;
}

/**
 * Better Auth with database sessions. Cookie caching stays disabled so that a
 * revoked session is rejected on the very next request.
 */
export const auth = betterAuth({
	baseURL: fixedOrigin ?? undefined,
	secret: env.BETTER_AUTH_SECRET,
	// Called once at start-up without a request, then per request.
	trustedOrigins: (request?: Request) => {
		const own = request ? requestOrigin(request) : null;
		// Production trusts exactly ORIGIN. `vite dev` also trusts its own dev-server origin so the
		// same .env can hold the Docker ORIGIN (e.g. http://localhost:8080) without breaking sign-in.
		if (fixedOrigin) return dev && own ? [fixedOrigin, own] : [fixedOrigin];
		return own ? [own] : [];
	},
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
		// Secure cookies follow the scheme users actually reach us on; forcing them on a
		// plain-http LAN install would make sign-in silently fail.
		useSecureCookies: fixedOrigin ? fixedOrigin.startsWith('https://') : undefined,
		cookiePrefix: 'mk'
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
