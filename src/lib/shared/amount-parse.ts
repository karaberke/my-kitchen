import { Dec } from './decimal';

export type ParsedAmount = { ok: true; value: Dec | null } | { ok: false; error: string };

const VULGAR: Record<string, [number, number]> = {
	'½': [1, 2],
	'⅓': [1, 3],
	'⅔': [2, 3],
	'¼': [1, 4],
	'¾': [3, 4],
	'⅕': [1, 5],
	'⅖': [2, 5],
	'⅗': [3, 5],
	'⅘': [4, 5],
	'⅙': [1, 6],
	'⅚': [5, 6],
	'⅛': [1, 8],
	'⅜': [3, 8],
	'⅝': [5, 8],
	'⅞': [7, 8]
};

const MAX = Dec.from('10000000'); // 10 million of any unit is beyond any kitchen

function finish(make: () => Dec): ParsedAmount {
	let value: Dec;
	try {
		value = make();
	} catch {
		return { ok: false, error: 'Amount is too large' };
	}
	if (value.isNegative()) return { ok: false, error: 'Amount cannot be negative' };
	if (value.gte(MAX)) return { ok: false, error: 'Amount is too large' };
	return { ok: true, value };
}

/**
 * Deterministic amount parser for recipe/pantry inputs.
 * Blank -> unknown (null). Accepts decimals ("1.5", "1,5"), fractions ("1/2",
 * "1 1/2") and unicode vulgar fractions ("½", "1½"). Never guesses.
 */
export function parseAmount(raw: string): ParsedAmount {
	const s = raw.trim().replace(/\s+/g, ' ');
	if (s === '') return { ok: true, value: null };

	const vulgar = /^(\d+)?\s?([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])$/.exec(s);
	if (vulgar) {
		const whole = vulgar[1] ? BigInt(vulgar[1]) : 0n;
		const [n, d] = VULGAR[vulgar[2]];
		return finish(() => Dec.from(whole).add(Dec.from(n).mulRatio(1, d)));
	}

	const mixed = /^(\d+) (\d+)\/(\d+)$/.exec(s);
	if (mixed) {
		const d = Number(mixed[3]);
		if (d === 0) return { ok: false, error: 'Fraction denominator cannot be zero' };
		return finish(() => Dec.from(BigInt(mixed[1])).add(Dec.from(Number(mixed[2])).mulRatio(1, d)));
	}

	const fraction = /^(\d+)\/(\d+)$/.exec(s);
	if (fraction) {
		const d = Number(fraction[2]);
		if (d === 0) return { ok: false, error: 'Fraction denominator cannot be zero' };
		return finish(() => Dec.from(Number(fraction[1])).mulRatio(1, d));
	}

	if (/^\d*[.,]?\d*$/.test(s) && /\d/.test(s)) {
		const commas = (s.match(/,/g) ?? []).length;
		if (commas > 1) return { ok: false, error: 'Use a single decimal separator' };
		const normalised = s.replace(',', '.');
		return finish(() => Dec.from(normalised));
	}

	if (s.includes(',') && s.includes('.')) {
		return { ok: false, error: 'Use a single decimal separator, without thousands grouping' };
	}
	return { ok: false, error: 'Enter a number such as 2, 1.5, 1/2 or 1 ½' };
}
