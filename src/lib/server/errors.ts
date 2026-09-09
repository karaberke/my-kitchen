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
