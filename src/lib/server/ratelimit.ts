/**
 * Small in-memory sliding-window rate limiter for the form-based auth actions.
 * Better Auth's own limiter only guards its HTTP handler; our server-side
 * `auth.api.*` calls bypass it, so the form actions apply this one.
 * Single-process by design (one app instance in v1); a restart resets it.
 */
const buckets = new Map<string, number[]>();
let lastSweep = Date.now();

export interface RateLimitRule {
	windowMs: number;
	max: number;
}

const factor = Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1; // tests raise this; production keeps 1

export const AUTH_LIMITS = {
	signIn: { windowMs: 60_000, max: 8 * factor },
	signUp: { windowMs: 60_000, max: 5 * factor },
	password: { windowMs: 60_000, max: 5 * factor }
} as const;

function sweep(now: number) {
	if (now - lastSweep < 60_000) return;
	lastSweep = now;
	for (const [key, hits] of buckets) {
		if (!hits.length || hits[hits.length - 1] < now - 10 * 60_000) buckets.delete(key);
	}
}

/** Returns the remaining allowance; 0 means the caller must reject. Records the hit when allowed. */
export function consume(
	key: string,
	rule: RateLimitRule,
	now = Date.now()
): { allowed: boolean; retryAfterSeconds: number } {
	sweep(now);
	const hits = (buckets.get(key) ?? []).filter((t) => t > now - rule.windowMs);
	if (hits.length >= rule.max) {
		const retryAfterSeconds = Math.max(1, Math.ceil((hits[0] + rule.windowMs - now) / 1000));
		buckets.set(key, hits);
		return { allowed: false, retryAfterSeconds };
	}
	hits.push(now);
	buckets.set(key, hits);
	return { allowed: true, retryAfterSeconds: 0 };
}

/** Test hook. */
export function resetRateLimits() {
	buckets.clear();
}
