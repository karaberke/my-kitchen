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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a calendar date that exists, written YYYY-MM-DD ("2026-02-31" is false). */
export function isIsoDate(value: unknown): value is string {
	if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
	const d = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The calendar date `days` after (or before, when negative) a YYYY-MM-DD date. */
export function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}
