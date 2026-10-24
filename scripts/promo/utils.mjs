/** Shared settings and safety checks for the isolated promotional recording. */
import { fileURLToPath } from 'node:url';

export const PROMO_BASE_URL = 'http://127.0.0.1:5180';
export const PROMO_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
export const PROMO_OUTPUT_DIR = fileURLToPath(new URL('../../artifacts/promo/', import.meta.url));
export const PROMO_VIEWPORT = { width: 390, height: 844 };
export const PROMO_SEGMENT_SECONDS = Object.freeze({
	plan: 6,
	recipe: 6,
	grocery: 7,
	ask: 13,
	cook: 11,
	success: 3
});
export const PROMO_DURATION_SECONDS = Object.values(PROMO_SEGMENT_SECONDS).reduce(
	(total, seconds) => total + seconds,
	0
);

export function assertPromoDatabase(databaseUrl) {
	const database = new URL(databaseUrl);
	if (
		process.env.NODE_ENV === 'production' ||
		!['postgres:', 'postgresql:'].includes(database.protocol) ||
		database.hostname !== '127.0.0.1' ||
		database.port !== '5433' ||
		!/^\/recipe_promo_\d+$/.test(database.pathname)
	) {
		throw new Error(
			'Filming requires an isolated recipe_promo_<timestamp> database on 127.0.0.1:5433.'
		);
	}
	return database;
}
