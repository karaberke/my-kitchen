import { env as dynamic } from '$env/dynamic/private';
import { building } from '$app/environment';
import { z } from 'zod';

const schema = z.object({
	DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
	DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
	DATABASE_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(10),
	DATABASE_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(30),
	DATABASE_SSL: z.string().optional().default(''),
	ORIGIN: z.string().url().default('http://localhost:5173'),
	BETTER_AUTH_SECRET: z.string().min(16, 'BETTER_AUTH_SECRET must be at least 16 characters'),
	REGISTRATION_OPEN: z
		.string()
		.optional()
		.default('true')
		.transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
	STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
	UPLOAD_DIR: z.string().default('./data/uploads'),
	S3_BUCKET: z.string().optional().default(''),
	S3_REGION: z.string().optional().default(''),
	S3_ENDPOINT: z.string().optional().default(''),
	S3_ACCESS_KEY_ID: z.string().optional().default(''),
	S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
	S3_FORCE_PATH_STYLE: z
		.string()
		.optional()
		.default('false')
		.transform((v) => ['true', '1', 'yes'].includes(v.trim().toLowerCase())),
	UPLOAD_MAX_BYTES: z.coerce
		.number()
		.int()
		.min(1024)
		.default(5 * 1024 * 1024),
	IMAGE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
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
	if (parsed.data.STORAGE_BACKEND === 's3') {
		const missing = ['S3_BUCKET', 'S3_REGION'].filter((k) => !parsed.data[k as keyof ServerEnv]);
		if (missing.length) throw new Error(`STORAGE_BACKEND=s3 requires ${missing.join(', ')}`);
	}
	cached = parsed.data;
	return cached;
}

export function isProduction(): boolean {
	return serverEnv().NODE_ENV === 'production';
}
