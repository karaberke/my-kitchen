import { Dec } from '$lib/shared/decimal';
import { formatQuantity } from '$lib/shared/units';
import { parseDbTimestamp } from '$lib/shared/time';

export { parseDbTimestamp };

export function fmtQty(amount: string | null | undefined, unit: string | null | undefined): string {
	if (amount === null || amount === undefined) return 'unknown amount';
	return formatQuantity(Dec.from(amount), unit ?? null);
}

export function fmtNum(amount: string | null | undefined): string {
	if (amount === null || amount === undefined) return '';
	return Dec.from(amount).toHuman();
}

export function fmtDateTime(value: string | null | undefined): string {
	if (!value) return '';
	const d = parseDbTimestamp(value);
	return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtDate(value: string | null | undefined): string {
	if (!value) return '';
	const d = value.length === 10 ? new Date(value + 'T00:00:00') : parseDbTimestamp(value);
	return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function fmtRelative(value: string | null | undefined): string {
	if (!value) return '';
	const then = parseDbTimestamp(value).getTime();
	const diff = Date.now() - then;
	const min = Math.round(diff / 60000);
	if (min < 1) return 'just now';
	if (min < 60) return `${min} min ago`;
	const h = Math.round(min / 60);
	if (h < 24) return `${h} h ago`;
	const days = Math.round(h / 24);
	if (days < 7) return `${days} d ago`;
	return fmtDate(value);
}

export function fmtMinutes(min: number | null | undefined): string {
	if (!min) return '';
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return m ? `${h} h ${m} min` : `${h} h`;
}

export function initials(name: string): string {
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]!.toUpperCase())
		.join('');
}
