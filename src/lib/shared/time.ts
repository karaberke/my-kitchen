/** Parse PostgreSQL text timestamps ("2026-09-09 01:02:03.123456+00") and ISO strings into a Date. */
export function parseDbTimestamp(value: string): Date {
	let iso = value.includes('T') ? value : value.replace(' ', 'T');
	// Postgres emits "+00" / "-05" / "+05:30" offsets; JS needs "+00:00" or "Z"
	iso = iso.replace(/([+-]\d\d)$/, '$1:00');
	if (!/(Z|[+-]\d\d:\d\d)$/.test(iso)) iso += 'Z';
	return new Date(iso);
}

export function dbTimestampMs(value: string): number {
	return parseDbTimestamp(value).getTime();
}
