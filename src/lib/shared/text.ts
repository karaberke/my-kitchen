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

export function slugKey(raw: string): string {
	return normalizeName(raw).replace(/\s/g, '-');
}
