import type { ParamMatcher } from '@sveltejs/kit';

/**
 * Route parameters that reach a `uuid` column.
 *
 * Without this a malformed id is handed to PostgreSQL, which rejects it with
 * `22P02 invalid_text_representation` — a driver error, not an AppError, so it
 * surfaced as a 500 instead of a 404. Matching first means the query never runs.
 */
export const match: ParamMatcher = (param) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);
