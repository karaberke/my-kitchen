/** Normalise a name for matching: lowercase, trimmed, collapsed whitespace, no diacritics. */
export function normalizeName(raw: string): string {
	return raw
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
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
