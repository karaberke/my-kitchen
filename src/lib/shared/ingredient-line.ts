import { parseAmount, VULGAR_CLASS } from './amount-parse';
import type { Dec } from './decimal';
import type { RecipeIngredientInput } from './recipe-input';
import { collapseSpaces, normalizeName } from './text';
import { normalizeUnitInput, readUnitToken } from './units';

/**
 * One quantity: "200", "1.5", "1,5", "1/2", "1 1/2", "½", "1½", "2-3".
 * Longest forms first, so "1½" is not read as a bare "1". Not anchored; the
 * steps (`step-amounts.ts`) look for it anywhere in a sentence.
 */
export const QUANTITY_PATTERN =
	'(' +
	[
		`\\d+\\s*${VULGAR_CLASS}`, // 1½
		'\\d+\\s+\\d+/\\d+', // 1 1/2
		'\\d+/\\d+', // 1/2
		VULGAR_CLASS, // ½
		'\\d+(?:[.,]\\d+)?(?:\\s*[-–—]\\s*\\d+(?:[.,]\\d+)?)?' // 200, 1.5, 2-3
	].join('|') +
	')';

/** The dash between the two ends of a range such as "2-3" or "2 – 3". */
export const RANGE_SEPARATOR = /\s*[-–—]\s*/;

/** A leading quantity and the space after it. */
const QUANTITY = new RegExp(`^${QUANTITY_PATTERN}\\s*`);

export interface SplitIngredient {
	amount: string;
	unit: string;
	name: string;
	/** the line exactly as the source wrote it */
	original: string;
}

/** `SplitIngredient` with the amount still a Dec; null when there is none. */
interface ParsedLine extends Omit<SplitIngredient, 'amount'> {
	amount: Dec | null;
}

/** A range ("2-3 tbsp") keeps its low end, which is the safe amount to shop for. */
function lowEnd(quantity: string): string {
	return quantity.split(RANGE_SEPARATOR)[0];
}

function parseLine(line: string): ParsedLine {
	const original = collapseSpaces(line);
	const empty = { amount: null, unit: '', name: original, original };
	if (!original) return { ...empty, name: '' };

	const m = QUANTITY.exec(original);
	if (!m) return empty;

	const parsed = parseAmount(lowEnd(m[1]));
	if (!parsed.ok || parsed.value === null) return empty;

	let rest = original.slice(m[0].length).trim();
	let unit = '';
	const words = rest.split(' ');
	const token = readUnitToken(words);
	if (token) {
		unit = token.unit;
		rest = words.slice(token.words).join(' ').trim();
	}
	rest = rest.replace(/^of\s+/i, '').trim();

	let amount = parsed.value;
	// "1 can (400 ml) coconut milk": the parenthesised measure is the one worth
	// tracking, so it wins over the container count.
	const paren = /^\(\s*([^)]+?)\s*\)\s*/.exec(rest);
	if (paren) {
		const inner = QUANTITY.exec(paren[1]);
		const innerAmount = inner ? parseAmount(lowEnd(inner[1])) : ({ ok: false } as const);
		// Only when the brackets hold exactly a measure, e.g. "(400 ml)".
		const innerUnit = inner ? normalizeUnitInput(paren[1].slice(inner[0].length)) : null;
		if (inner && innerAmount.ok && innerAmount.value !== null && innerUnit) {
			amount = innerAmount.value;
			unit = innerUnit;
			rest = rest.slice(paren[0].length).trim();
		}
	}

	// Without a name there is nothing to track; keep the line as written.
	if (!rest) return empty;
	return { amount, unit, name: rest, original };
}

/**
 * Split "200 g red lentils" into amount, unit and name so imported recipes can
 * scale and match the pantry like hand-entered ones. Anything it cannot read
 * confidently stays in the name — it never guesses a quantity.
 */
export function splitIngredientLine(line: string): SplitIngredient {
	const parsed = parseLine(line);
	return { ...parsed, amount: parsed.amount ? parsed.amount.toString() : '' };
}

/** A count written as a multiplier: "2x tins", "3 × 400 g". */
const MULTIPLIER = new RegExp(`^${QUANTITY_PATTERN}\\s*[x×](?=\\s|$)`, 'i');

/**
 * Read an item typed on a grocery list with no amount fields, such as
 * "400 g chopped tomatoes", into amount, unit and name. Null when the text is
 * not that plain: a multiplier ("2x tins …"), a second number in the name
 * ("tins chopped tomatoes 400g"), a name that does not start with a letter, or
 * a number joined to a word that is not a unit ("7up"). Then the item stays as
 * typed; this never guesses.
 */
export function parseGroceryEntry(
	text: string
): { amount: Dec; unit: string | null; name: string } | null {
	const split = parseLine(text);
	if (!split.amount || !split.name) return null;
	if (MULTIPLIER.test(split.original)) return null;
	if (!/^\p{L}/u.test(split.name) || /\d/.test(split.name)) return null;
	if (!split.unit && !split.original.endsWith(` ${split.name}`)) return null;
	if (!split.amount.isPositive()) return null;
	return { amount: split.amount, unit: split.unit || null, name: split.name };
}

/** A split ingredient line as a form row. */
export function ingredientFromSplit(split: SplitIngredient): RecipeIngredientInput {
	return {
		name: split.name,
		ingredientId: null,
		amount: split.amount,
		unit: split.unit,
		// Keep the source's exact wording so nothing is lost in the split.
		preparation: split.name === split.original ? '' : split.original,
		group: '',
		optional: false,
		createIdentity: false
	};
}

/** One written ingredient line as a form row, split into amount, unit and name. */
export function ingredientFromLine(line: string): RecipeIngredientInput {
	return ingredientFromSplit(splitIngredientLine(line));
}

/**
 * One ingredient as a single line: "200 g onion, diced".
 *
 * An import keeps the original wording in `preparation` ("2 tbsp cream cheese"),
 * which the quantity and the name already say, so a note is appended only when
 * it adds something: one that repeats the name and carries an amount is dropped.
 */
export function ingredientLine(input: {
	quantity: string;
	name: string;
	preparation: string;
}): string {
	const head = `${input.quantity ? input.quantity + ' ' : ''}${input.name}`;
	const prep = input.preparation.trim();
	const repeatsLine = /\d/.test(prep) && normalizeName(prep).includes(normalizeName(input.name));
	return prep && !repeatsLine ? `${head}, ${prep}` : head;
}
