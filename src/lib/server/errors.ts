import postgres from 'postgres';

/** Error with an HTTP status, safe to show to the user. */
export class AppError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly details?: Record<string, unknown>
	) {
		super(message);
		this.name = 'AppError';
	}
}

/** Review conflict: the client must look at fresh data before retrying. */
export class ReviewConflict<T = unknown> extends AppError {
	constructor(
		message: string,
		public readonly review: T
	) {
		super(409, message, { review: true });
		this.name = 'ReviewConflict';
	}
}

export function notFound(what = 'Not found'): AppError {
	return new AppError(404, what);
}

export function forbidden(message = 'You do not have access to this'): AppError {
	return new AppError(403, message);
}

/**
 * The PostgreSQL error behind a query failure, or null.
 *
 * Drizzle wraps driver errors in `DrizzleQueryError` and keeps the original on
 * `.cause`, so `err instanceof postgres.PostgresError` is false for anything
 * thrown by a query builder. Every SQLSTATE check goes through this.
 */
export function pgError(err: unknown): postgres.PostgresError | null {
	if (err instanceof postgres.PostgresError) return err;
	const cause = (err as { cause?: unknown } | null)?.cause;
	return cause instanceof postgres.PostgresError ? cause : null;
}

export function pgErrorCode(err: unknown): string | null {
	return pgError(err)?.code ?? null;
}

/**
 * `22P02 invalid_text_representation` — a malformed uuid (or other typed value)
 * reached a query. Callers hand the client a 404 rather than a 500: an id that
 * cannot exist is indistinguishable from one that does not.
 */
export function isInvalidTextRepresentation(err: unknown): boolean {
	return pgErrorCode(err) === '22P02';
}

/** Normalise a malformed-id query failure into a 404; rethrow anything else. */
export function rethrowAsNotFound(err: unknown, what = 'Not found'): never {
	if (isInvalidTextRepresentation(err)) throw notFound(what);
	throw err;
}

/**
 * The AppError a caller should surface for this failure, or null to rethrow.
 *
 * Beyond real AppErrors this maps a malformed uuid (22P02) to a 404. Route
 * parameters are screened by the `uuid` matcher, but ids also arrive in form
 * bodies (lotId, batchId, entryId, inviteId ...), where a hand-edited value
 * would otherwise reach PostgreSQL and come back as a 500.
 */
export function asAppError(err: unknown): AppError | null {
	if (err instanceof AppError) return err;
	if (isInvalidTextRepresentation(err)) return notFound();
	return null;
}
