import { normalizeName } from './text';

/** "olives" -> "olive", "berries" -> "berry", "tomatoes" -> "tomato"; "cress" stays. */
function singular(name: string): string | null {
	if (/(^|\s)\S*ies$/.test(name)) return name.replace(/ies$/, 'y');
	if (/(ch|sh|s|x|z)es$/.test(name)) return name.replace(/es$/, '');
	if (/oes$/.test(name)) return name.replace(/es$/, '');
	if (/[^s]s$/.test(name)) return name.replace(/s$/, '');
	return null;
}

/**
 * The names to look up for one recipe ingredient, best first. Each rule only
 * removes wording the catalog never carries; nothing splits a name, so a line
 * that holds a choice ("sugar or honey") stays unmatched on purpose.
 */
export function matchCandidates(raw: string): string[] {
	const base = normalizeName(raw);
	if (!base) return [];
	const withoutBrackets = normalizeName(raw.replace(/\([^)]*\)/g, ' '));
	const cutAtComma = normalizeName(raw.split(',')[0]);
	const both = normalizeName(raw.replace(/\([^)]*\)/g, ' ').split(',')[0]);
	const out: string[] = [];
	for (const name of [base, withoutBrackets, cutAtComma, both]) {
		if (name && !out.includes(name)) out.push(name);
	}
	for (const name of [...out]) {
		const one = singular(name);
		if (one && !out.includes(one)) out.push(one);
	}
	return out;
}
