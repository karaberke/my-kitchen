/**
 * Small in-memory sliding-window rate limiter for the form-based auth actions.
 * Better Auth's own limiter only guards its HTTP handler; our server-side
 * `auth.api.*` calls bypass it, so the form actions apply this one.
 * Single-process by design (one app instance in v1); a restart resets it.
 */
import { serverEnv } from './env';

/** Hit times per key, with the window of the rule that fills the bucket, so the sweep keeps it as long as that rule needs. */
const buckets = new Map<string, { hits: number[]; windowMs: number }>();
let lastSweep = Date.now();

export interface RateLimitRule {
	windowMs: number;
	max: number;
}

/** Read at use, not at import: the environment is validated on first use (tests raise the factor; production keeps 1). */
function authRule(max: number): RateLimitRule {
	return { windowMs: 60_000, max: max * serverEnv().AUTH_RATE_LIMIT_FACTOR };
}

export const AUTH_LIMITS = {
	get signIn() {
		return authRule(8);
	},
	get signUp() {
		return authRule(5);
	},
	get password() {
		return authRule(5);
	}
};

/**
 * Fetching a link the user gave — a recipe page, or a picture. The fetch reaches
 * any address the host can route to, so these buckets are what stop one cook
 * from using the box as a scanner. Keyed by user.
 */
export const IMPORT_LIMITS = {
	fetch: { windowMs: 60_000, max: 10 },
	image: { windowMs: 60_000, max: 10 }
} as const;

/** Barcode lookups a signed-in person may ask for. Keyed by user. */
export const BARCODE_LIMITS = {
	lookup: { windowMs: 60_000, max: 40 }
} as const;

/**
 * What this server may ask of each product database.
 *
 * These buckets are NOT keyed by user. Both providers limit by IP address, and
 * every household on one install shares the server's address, so the whole
 * process shares one allowance and stays inside the published limits: Open
 * Food Facts permits 15 product reads a minute per address, and USDA permits
 * 1000 requests an hour. Both figures are left some headroom.
 */
export const PROVIDER_LIMITS = {
	usda: { windowMs: 3_600_000, max: 800 },
	off: { windowMs: 60_000, max: 12 }
} as const;

/**
 * Calls to the AI assistant. The model server is one small CPU box that runs
 * one request at a time, so a cook gets a few calls, not a queue of them.
 * Keyed by user and rule: each rule has its own bucket.
 */
export const LLM_LIMITS = {
	user: { windowMs: 10 * 60_000, max: 10 },
	/** Questions about a recipe: a conversation while cooking needs more than an import does. */
	chat: { windowMs: 10 * 60_000, max: 30 }
} as const;

function sweep(now: number) {
	if (now - lastSweep < 60_000) return;
	lastSweep = now;
	for (const [key, { hits, windowMs }] of buckets) {
		if (!hits.length || hits[hits.length - 1] <= now - windowMs) buckets.delete(key);
	}
}

/** Returns the remaining allowance; 0 means the caller must reject. Records the hit when allowed. */
export function consume(
	key: string,
	rule: RateLimitRule,
	now = Date.now()
): { allowed: boolean; retryAfterSeconds: number } {
	sweep(now);
	const bucket = buckets.get(key);
	const hits = (bucket?.hits ?? []).filter((t) => t > now - rule.windowMs);
	const windowMs = Math.max(bucket?.windowMs ?? 0, rule.windowMs);
	if (hits.length >= rule.max) {
		const retryAfterSeconds = Math.max(1, Math.ceil((hits[0] + rule.windowMs - now) / 1000));
		buckets.set(key, { hits, windowMs });
		return { allowed: false, retryAfterSeconds };
	}
	hits.push(now);
	buckets.set(key, { hits, windowMs });
	return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Client address for rate-limit keys.
 *
 * adapter-node's getClientAddress() throws when ADDRESS_HEADER names a header
 * the request does not carry — a real risk on a host that is reachable both
 * through the proxy and directly. Falling back to a constant degrades to one
 * shared bucket (the behaviour before ADDRESS_HEADER existed) instead of
 * turning every sign-in into a 500.
 */
export function clientKey(event: { getClientAddress: () => string }): string {
	try {
		return event.getClientAddress() || 'unknown';
	} catch {
		return 'unknown';
	}
}

/** Test hook. */
export function resetRateLimits() {
	buckets.clear();
	lastSweep = 0;
}
