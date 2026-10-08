import { Dec } from './decimal';
import { parseAmount } from './amount-parse';
import { singular } from './ingredient-name';
import { QUANTITY_PATTERN, RANGE_SEPARATOR } from './ingredient-line';
import { scaleAmount } from './scaling';
import { normalizeName } from './text';
import { formatQuantity, readUnitToken, unitsCompatible } from './units';

/**
 * Amounts in the step text that belong to an ingredient, so they scale with
 * the servings like the ingredient list does.
 *
 * A link is an automatic change to what the cook reads, so it is strict: an
 * amount links only when it is clearly tied to one ingredient, either by the
 * ingredient's name right after it ("200 g flour") or, with no name, by being
 * exactly one ingredient's amount and unit ("add 200 g and stir"). Anything
 * else (oven temperatures, times, pan sizes, "cut into 4 pieces") stays as
 * written.
 */

export interface StepIngredient {
	name: string;
	amount: string | null;
	unit: string | null;
}

export type StepPart =
	| { text: string }
	| {
			/** the amount as the step writes it, unit included */
			text: string;
			amount: Dec;
			/** the top of a range such as "2-3 tbsp" */
			amountHigh: Dec | null;
			unit: string | null;
			/** index into the ingredient list */
			ingredient: number;
	  };

/** The most words after the amount and unit that are read as a name. */
const NAME_WORDS = 4;
/** Words that tie an amount to a name without being part of it. */
const LINK_WORDS = new Set(['of', 'the']);
/** Words too common to tie an amount to an ingredient on their own. */
const WEAK_WORDS = new Set([
	'and',
	'or',
	'of',
	'the',
	'a',
	'an',
	'in',
	'with',
	'for',
	'to',
	'into'
]);

/** A quantity that is not the end of another number or word ("step2", "10:30", "1.5"). */
const STEP_QUANTITY = new RegExp(`(?<![\\p{L}\\p{N}.,/:])${QUANTITY_PATTERN}`, 'gu');
const WORD = /^\s*([^\s,.;:!?()]+)/;

function words(text: string): string[] {
	return normalizeName(text)
		.split(' ')
		.filter(Boolean)
		.map((w) => singular(w) ?? w);
}

/**
 * How well the leading words of `step` name this ingredient: twice the words
 * that appear in a row in `name`, plus one when they are the whole name, so
 * "sugar" is "sugar" and not "brown sugar". 0 when none or only weak words.
 */
function nameMatch(step: string[], name: string[]): number {
	let best = 0;
	for (let k = Math.min(step.length, name.length); k > best; k--) {
		const window = step.slice(0, k);
		if (window.every((w) => WEAK_WORDS.has(w))) continue;
		for (let at = 0; at + k <= name.length; at++) {
			if (window.every((w, i) => name[at + i] === w)) {
				best = k;
				break;
			}
		}
	}
	return best ? best * 2 + (best === name.length ? 1 : 0) : 0;
}

function unitsFit(step: string | null, ingredient: string | null): boolean {
	if (!step || !ingredient) return (step ?? 'piece') === (ingredient ?? 'piece');
	return unitsCompatible(step, ingredient);
}

/** The text after a quantity: its unit and the words that may name an ingredient. */
function readAfter(rest: string): { unit: string | null; length: number; names: string[] } {
	let length = 0;
	let unit: string | null = null;
	const tokens: { word: string; end: number }[] = [];
	let at = 0;
	while (tokens.length < NAME_WORDS + 2) {
		const m = WORD.exec(rest.slice(at));
		if (!m) break;
		at += m[0].length;
		tokens.push({ word: m[1], end: at });
	}
	const token = readUnitToken(tokens.map((t) => t.word));
	if (token) {
		unit = token.unit;
		length = tokens[token.words - 1].end;
		tokens.splice(0, token.words);
	}
	const names = tokens.flatMap((t) => words(t.word));
	while (names.length && LINK_WORDS.has(names[0])) names.shift();
	return { unit, length, names: names.slice(0, NAME_WORDS) };
}

/** The one ingredient this amount belongs to, or -1. */
function linkFor(
	amount: Dec,
	unit: string | null,
	names: string[],
	ingredients: PreparedStepIngredients['prepared']
): number {
	let best = 0;
	let found: number[] = [];
	ingredients.forEach((ing, i) => {
		if (!unitsFit(unit, ing.unit)) return;
		const score = nameMatch(names, ing.words);
		if (score === 0 || score < best) return;
		if (score > best) found = [];
		best = score;
		found.push(i);
	});
	if (found.length === 1) return found[0];
	if (best > 0 || !unit) return -1;
	// No name: only an exact amount and unit that one ingredient has.
	const same = ingredients.flatMap((ing, i) =>
		ing.unit === unit && ing.amount?.eq(amount) ? [i] : []
	);
	return same.length === 1 ? same[0] : -1;
}

/**
 * A recipe's ingredients read one time for `findStepAmounts`: name words,
 * parsed amount and unit. Prepare once per recipe and pass the result for
 * each step, so a step does not parse every ingredient again.
 */
export interface PreparedStepIngredients {
	readonly prepared: readonly { words: string[]; amount: Dec | null; unit: string | null }[];
}

export function prepareStepIngredients(ingredients: StepIngredient[]): PreparedStepIngredients {
	return {
		prepared: ingredients.map((ing) => {
			const amount = ing.amount ? parseAmount(ing.amount) : null;
			// "flour, sifted" and "eggs (large)" are named by what comes before.
			const name = ing.name.replace(/\([^)]*\)/g, ' ').split(',')[0];
			return {
				words: words(name),
				amount: amount?.ok ? amount.value : null,
				unit: ing.unit || null
			};
		})
	};
}

type StepIngredients = StepIngredient[] | PreparedStepIngredients;

function prepared(ingredients: StepIngredients): PreparedStepIngredients {
	return Array.isArray(ingredients) ? prepareStepIngredients(ingredients) : ingredients;
}

/** Split a step into plain text and the amounts that link to an ingredient. */
export function findStepAmounts(text: string, ingredients: StepIngredients): StepPart[] {
	const known = prepared(ingredients);
	const parts: StepPart[] = [];
	let from = 0;
	for (const m of text.matchAll(STEP_QUANTITY)) {
		const start = m.index;
		if (start < from) continue;
		const [lowRaw, highRaw] = m[1].split(RANGE_SEPARATOR);
		const low = parseAmount(lowRaw);
		const high = highRaw ? parseAmount(highRaw) : null;
		if (!low.ok || !low.value || (high && (!high.ok || !high.value))) continue;
		const after = readAfter(text.slice(start + m[0].length));
		const ingredient = linkFor(low.value, after.unit, after.names, known.prepared);
		if (ingredient < 0) continue;
		const end = start + m[0].length + after.length;
		if (start > from) parts.push({ text: text.slice(from, start) });
		parts.push({
			text: text.slice(start, end),
			amount: low.value,
			amountHigh: high?.ok ? high.value : null,
			unit: after.unit,
			ingredient
		});
		from = end;
	}
	if (from < text.length || !parts.length) parts.push({ text: text.slice(from) });
	return parts;
}

/** A linked amount after scaling, as the cook should read it. */
export interface ScaledStepPart {
	text: string;
	/** the amount as the step writes it; set only when `text` changed */
	original: string | null;
}

/**
 * The step with its linked amounts scaled from `base` to `target` servings.
 * `format` writes one amount (the browser passes `displayQuantity`, so the
 * unit system applies as in the ingredient list). At the base servings an
 * amount keeps the step's own wording unless `format` converts its unit.
 */
export function scaleStepText(
	text: string,
	ingredients: StepIngredients,
	base: Dec,
	target: Dec,
	format: AmountFormat = formatQuantity
): ScaledStepPart[] {
	return scaleStepParts(findStepAmounts(text, ingredients), base, target, format);
}

/** Writes one amount in its unit. */
export type AmountFormat = (amount: Dec, unit: string | null) => string;

/**
 * `scaleStepText` for parts that `findStepAmounts` already found, so a caller
 * that keeps the parts can scale again without matching the text again.
 */
export function scaleStepParts(
	parts: StepPart[],
	base: Dec,
	target: Dec,
	format: AmountFormat = formatQuantity
): ScaledStepPart[] {
	const same = base.eq(target);
	return parts.map((part) => {
		if (!('amount' in part)) return { text: part.text, original: null };
		const scale = (v: Dec) => (same ? v : (scaleAmount(v, base, target) ?? v));
		const low = scale(part.amount);
		let written = format(low, part.unit);
		if (same && written === formatQuantity(low, part.unit))
			return { text: part.text, original: null };
		if (part.amountHigh) {
			const high = format(scale(part.amountHigh), part.unit);
			// "2–3 tbsp" rather than "2 tbsp–3 tbsp" when both ends share the unit.
			const space = written.lastIndexOf(' ');
			const lowText =
				space > 0 && high.endsWith(written.slice(space)) ? written.slice(0, space) : written;
			written = `${lowText}–${high}`;
		}
		return { text: written, original: part.text };
	});
}

/** The step as one string with its amounts scaled; for the plain-text recipe. */
export function scaledStepLine(
	text: string,
	ingredients: StepIngredients,
	base: Dec,
	target: Dec
): string {
	return scaleStepText(text, ingredients, base, target)
		.map((p) => p.text)
		.join('');
}
