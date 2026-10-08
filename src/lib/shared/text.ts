/** The longest storage location a pantry lot keeps ("Fridge", "Top shelf"). */
export const LOCATION_MAX_CHARS = 60;
/** The longest note a pantry lot, grocery line, cooked item or stock movement keeps. */
export const NOTE_MAX_CHARS = 300;
/** The longest household name. */
export const HOUSEHOLD_NAME_MAX_CHARS = 60;
/** The longest display name of a person (account, admin bootstrap). */
export const PERSON_NAME_MAX_CHARS = 80;

/** Text on one line with single spaces and no space at either end. */
export function collapseSpaces(raw: string): string {
	return raw.trim().replace(/\s+/g, ' ');
}

/** `collapseSpaces`, then cut to at most `maxLength` characters. */
export function cleanText(raw: string, maxLength: number): string {
	return collapseSpaces(raw).slice(0, maxLength);
}

/** Text from the browser made safe for a prompt: no control characters, one line, at most `max` characters. */
export function cleanChatText(raw: string, max: number): string {
	return cleanText(raw.replace(/[\p{Cc}\p{Cf}]+/gu, ' '), max);
}

/** Normalise a name for matching: lowercase, trimmed, collapsed whitespace, no diacritics. */
export function normalizeName(raw: string): string {
	const cleaned = raw
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s'-]/gu, ' ');
	return collapseSpaces(cleaned);
}

const RFC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * An RFC 9562 UUID (version 1–8, variant 10xx), as `randomUUID()` makes. Stricter
 * than the route matcher in `src/params/uuid.ts`, which only keeps malformed text
 * away from a `uuid` column.
 */
export function isRfcUuid(value: unknown): value is string {
	return typeof value === 'string' && RFC_UUID.test(value);
}
