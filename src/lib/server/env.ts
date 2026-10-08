import { env as dynamic } from '$env/dynamic/private';
import { env as dynamicPublic } from '$env/dynamic/public';
import { building } from '$app/environment';
import { z } from 'zod';
import { PERSON_NAME_MAX_CHARS, cleanText } from '$lib/shared/text';

const TRUE_WORDS = ['true', '1', 'yes', 'on'];
const FALSE_WORDS = ['false', '0', 'no', 'off'];

/** An on/off variable. A word in neither list (or an empty value) keeps the default. */
function flag(fallback: boolean) {
	return z
		.string()
		.optional()
		.transform((v) => {
			const word = (v ?? '').trim().toLowerCase();
			if (TRUE_WORDS.includes(word)) return true;
			if (FALSE_WORDS.includes(word)) return false;
			return fallback;
		});
}

/**
 * A URL variable: trimmed, trailing slashes removed, then checked. Without
 * `path` it must be a bare origin; `allowEmpty` lets an empty value mean "off" or "auto".
 */
function urlVar(opts: {
	fallback: string;
	message: string;
	allowEmpty?: boolean;
	httpsOnly?: boolean;
	path?: boolean;
}) {
	const pattern = new RegExp(
		`^${opts.httpsOnly ? 'https' : 'https?'}:\\/\\/[^\\s/]+${opts.path ? '(\\/[^\\s]*)?' : ''}$`
	);
	return z
		.string()
		.optional()
		.default(opts.fallback)
		.transform((v) => v.trim().replace(/\/+$/, ''))
		.refine((v) => (opts.allowEmpty && v === '') || pattern.test(v), opts.message);
}

const schema = z.object({
	DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
	DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
	DATABASE_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(10),
	DATABASE_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(30),
	DATABASE_SSL: z.string().optional().default(''),
	/** Public URL users type. Empty = "auto": trust the origin of each request (behind a proxy/tunnel that sets X-Forwarded-Proto). */
	ORIGIN: urlVar({
		fallback: '',
		allowEmpty: true,
		message: 'ORIGIN must be a URL like https://pantry.example.com (or empty for auto)'
	}),
	BETTER_AUTH_SECRET: z.string().min(16, 'BETTER_AUTH_SECRET must be at least 16 characters'),
	REGISTRATION_OPEN: flag(true),
	/** Multiplies the sign-in, sign-up and password limits. Tests raise it; production keeps 1. */
	AUTH_RATE_LIMIT_FACTOR: z.coerce.number().min(1).max(1000).default(1),
	/**
	 * Social sign-in. Each provider turns itself on only when its credentials are
	 * present, so an install that sets none behaves exactly as before, and one that
	 * sets only some offers only those buttons.
	 */
	GOOGLE_CLIENT_ID: z.string().optional().default(''),
	GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
	MICROSOFT_CLIENT_ID: z.string().optional().default(''),
	MICROSOFT_CLIENT_SECRET: z.string().optional().default(''),
	/** "common" accepts personal and work accounts; a directory id restricts to one tenant. */
	MICROSOFT_TENANT_ID: z.string().optional().default('common'),
	/** Apple Services ID, not the app bundle id. */
	APPLE_CLIENT_ID: z.string().optional().default(''),
	/**
	 * Apple has no static secret: it is a JWT signed with the .p8 key, and Apple
	 * refuses one older than six months. Supply it pre-generated and rotate it.
	 */
	APPLE_CLIENT_SECRET: z.string().optional().default(''),
	/** Bundle id of the native app, when one shares these accounts. */
	APPLE_APP_BUNDLE_IDENTIFIER: z.string().optional().default(''),

	/** First account, created at start-up when it does not exist yet (see bootstrap.ts). */
	ADMIN_EMAIL: z
		.string()
		.optional()
		.default('')
		.transform((v) => v.trim().toLowerCase()),
	ADMIN_NAME: z
		.string()
		.optional()
		.default('')
		.transform((v) => cleanText(v, PERSON_NAME_MAX_CHARS)),
	ADMIN_PASSWORD: z.string().optional().default(''),
	STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
	UPLOAD_DIR: z.string().default('./data/uploads'),
	S3_BUCKET: z.string().optional().default(''),
	S3_REGION: z.string().optional().default(''),
	S3_ENDPOINT: z.string().optional().default(''),
	S3_ACCESS_KEY_ID: z.string().optional().default(''),
	S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
	S3_FORCE_PATH_STYLE: flag(false),
	UPLOAD_MAX_BYTES: z.coerce
		.number()
		.int()
		.min(1024)
		.default(5 * 1024 * 1024),
	IMAGE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),

	/**
	 * Barcode lookup. Every value is optional: an install that sets none still
	 * scans, still recognises what the household saved before, and still adds
	 * stock by hand. USDA is simply skipped when it has no key.
	 */
	USDA_API_KEY: z
		.string()
		.optional()
		.default('')
		.transform((v) => v.trim()),
	/**
	 * Only ever changed to point the tests at a local stub. Provider calls are
	 * made by this process, not by the browser, so a browser-side mock cannot
	 * reach them.
	 */
	USDA_BASE_URL: urlVar({
		fallback: 'https://api.nal.usda.gov',
		message: 'USDA_BASE_URL must be an origin such as https://api.nal.usda.gov'
	}),
	OFF_ENABLED: flag(true),
	/** Point this at https://world.openfoodfacts.net to work against staging. */
	OFF_BASE_URL: urlVar({
		fallback: 'https://world.openfoodfacts.org',
		httpsOnly: true,
		message: 'OFF_BASE_URL must be an https origin such as https://world.openfoodfacts.org'
	}),
	/** Open Food Facts asks every caller to identify itself and leave a contact. */
	OFF_CONTACT: z
		.string()
		.optional()
		.default('')
		.transform((v) => v.trim().slice(0, 120)),

	/**
	 * AI assistant: an OpenAI-compatible model server, such as
	 * http://192.0.2.10:8080/v1. Empty turns the feature off. The server calls
	 * it, not the browser, so it can stay on a private network. In Docker, do
	 * not use localhost: that is the app container itself.
	 */
	LLM_BASE_URL: urlVar({
		fallback: '',
		allowEmpty: true,
		path: true,
		message:
			'LLM_BASE_URL must be a URL such as http://192.0.2.10:8080/v1 (or empty to turn it off)'
	}),
	/** Most local servers ignore the key; the client still has to send one. */
	LLM_API_KEY: z
		.string()
		.optional()
		.default('')
		.transform((v) => v.trim() || 'none'),
	LLM_MODEL: z
		.string()
		.optional()
		.default('')
		.transform((v) => v.trim() || 'assistant'),
	NODE_ENV: z.string().optional().default('development')
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

/** Validated server environment. Throws a readable error at first use. */
export function serverEnv(): ServerEnv {
	if (cached) return cached;
	if (building) {
		// Image builds run without secrets or a database; runtime re-validates real values.
		return schema.parse({
			DATABASE_URL: 'postgres://build:build@localhost:5432/build',
			BETTER_AUTH_SECRET: 'build-time-placeholder-secret'
		});
	}
	const parsed = schema.safeParse(dynamic);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new Error(`Invalid server environment: ${issues}`);
	}
	if (parsed.data.ADMIN_EMAIL) {
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(parsed.data.ADMIN_EMAIL))
			throw new Error('ADMIN_EMAIL must be an email address');
		if (parsed.data.ADMIN_PASSWORD.length < 8 || parsed.data.ADMIN_PASSWORD.length > 128)
			throw new Error('ADMIN_PASSWORD must be 8 to 128 characters when ADMIN_EMAIL is set');
	}
	if (parsed.data.STORAGE_BACKEND === 's3') {
		const missing = ['S3_BUCKET', 'S3_REGION'].filter((k) => !parsed.data[k as keyof ServerEnv]);
		if (missing.length) throw new Error(`STORAGE_BACKEND=s3 requires ${missing.join(', ')}`);
	}
	cached = parsed.data;
	return cached;
}

/**
 * How often the client polls the `householdRevisions` query, floored so a low or missing
 * override can't hammer it. The root layout sends it to every page as `pollMs`.
 */
export function revisionPollMs(): number {
	return Math.max(3000, Number(dynamicPublic.PUBLIC_REVISION_POLL_MS ?? 20000) || 20000);
}
