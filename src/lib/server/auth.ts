import { betterAuth } from 'better-auth/minimal';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { dev } from '$app/environment';
import { db } from '$lib/server/db';
import { serverEnv } from '$lib/server/env';
import { ensurePersonalHousehold } from '$lib/server/households';
import { socialSignUpAllowed } from '$lib/server/registration';

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
 * Only providers whose credentials are configured are offered, so an install
 * that sets none keeps exactly today's behaviour and the sign-in page shows
 * only the buttons that can actually work.
 */
function socialProviders() {
	const p: Record<string, unknown> = {};
	if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
		p.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
	if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET)
		p.microsoft = {
			clientId: env.MICROSOFT_CLIENT_ID,
			clientSecret: env.MICROSOFT_CLIENT_SECRET,
			tenantId: env.MICROSOFT_TENANT_ID || 'common'
		};
	if (env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET)
		p.apple = {
			clientId: env.APPLE_CLIENT_ID,
			// A JWT signed with the .p8 key, which Apple rejects once older than six months.
			clientSecret: env.APPLE_CLIENT_SECRET,
			...(env.APPLE_APP_BUNDLE_IDENTIFIER
				? { appBundleIdentifier: env.APPLE_APP_BUNDLE_IDENTIFIER }
				: {})
		};
	return p;
}

/** Which providers the sign-in page should offer. */
export function enabledSocialProviders(): string[] {
	return Object.keys(socialProviders());
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
	socialProviders: socialProviders(),
	account: {
		accountLinking: {
			enabled: true,
			// Only ever link to a local account whose address is proven. Ours are all
			// unverified (no mail transport), so this refuses implicit linking and
			// existing users link deliberately from Settings instead — which closes
			// the pre-hijack attack, where someone registers your address first and
			// waits for your social sign-in to be merged into their account.
			requireLocalEmailVerified: true,
			// Never merge on a different address than the one already on file.
			allowDifferentEmails: false,
			trustedProviders: ['google', 'microsoft', 'apple']
		}
	},
	emailAndPassword: {
		enabled: true,
		// Sign-up policy (REGISTRATION_OPEN, invitation links, the ADMIN_* bootstrap) is enforced
		// by the app's own /register action and bootstrap.ts; the HTTP sign-up endpoint that
		// Better Auth would expose is blocked in hooks.server.ts.
		disableSignUp: false,
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
				/**
				 * The sign-up policy lives in the app's own /register action, and Better
				 * Auth's HTTP sign-up endpoint is blocked in hooks.server.ts — but a social
				 * callback creates users through neither of those. Without this, enabling a
				 * provider would quietly reopen sign-ups on a closed install.
				 */
				before: async (user, ctx) => {
					const allowed = await socialSignUpAllowed(db, ctx?.request ?? null);
					if (!allowed) {
						throw new APIError('FORBIDDEN', {
							message: 'This kitchen is invitation only. Ask a member for an invite link.'
						});
					}
					return { data: user };
				},
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
