import type { RecipeFormInput, RecipeStepInput } from './recipe-input';
import { emptyRecipeFormInput, splitIngredientLine } from './recipe-html';

/**
 * Best-effort reading of a recipe out of plain text — the shape you get from a
 * PDF's text layer. Layout is lost by then, so this leans on the words that
 * recipes almost always use, and never invents a value it cannot see.
 */

const INGREDIENT_HEADING = /^(ingredients|you will need|shopping list)\b[:\s]*$/i;
const STEP_HEADING = /^(method|instructions|directions|steps|preparation)\b[:\s]*$/i;
const OTHER_HEADING = /^(notes?|tips?|nutrition|equipment)\b[:\s]*$/i;

const SERVINGS = /(?:^|\b)(?:serves|servings?|yield|makes)\b[:\s]*(\d+(?:\.\d+)?)/i;
const SERVINGS_TRAILING = /^(\d+(?:\.\d+)?)\s+servings?\b/i;
const PREP = /\bprep(?:aration)?(?:\s*time)?\b[:\s]*(.+)$/i;
const COOK = /\b(?:cook|bake|total)(?:ing)?(?:\s*time)?\b[:\s]*(.+)$/i;

/** "1 hr 30 min", "45 minutes", "1h30" -> minutes. */
function timeToMinutes(raw: string): number | null {
	const s = raw.toLowerCase();
	const h = /(\d+(?:\.\d+)?)\s*(?:h\b|hr|hour)/.exec(s);
	const m = /(\d+)\s*(?:m\b|min)/.exec(s);
	if (!h && !m) {
		const bare = /^\s*(\d+)\s*$/.exec(s);
		return bare ? Number(bare[1]) : null;
	}
	return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0));
}

export interface TextImportResult {
	input: RecipeFormInput;
	/** 1-based source page for each ingredient, in the same order */
	ingredientPages: number[];
	/** true when the pages held no readable text at all (a scan, most likely) */
	empty: boolean;
}

interface Line {
	text: string;
	page: number;
}

const NUMBERED = /^\d+[.)]\s+/;

/** A line that plainly begins something new, so the one before it is finished. */
function startsNewItem(text: string): boolean {
	return (
		NUMBERED.test(text) ||
		INGREDIENT_HEADING.test(text) ||
		STEP_HEADING.test(text) ||
		OTHER_HEADING.test(text) ||
		!!splitIngredientLine(text).amount
	);
}

/**
 * PDF text arrives wrapped at the page's column width, so one sentence can span
 * several lines. Re-join a line onto the one before when that one clearly had
 * not finished — but never across something that starts a new item.
 */
function joinWrapped(lines: Line[]): Line[] {
	const out: Line[] = [];
	for (const line of lines) {
		const prev = out[out.length - 1];
		const wrapped =
			prev &&
			// Only a line long enough to have hit the column edge was wrapped; a
			// short one is a title or a label that simply has no full stop.
			prev.text.length >= 45 &&
			!/[.!?:;]$/.test(prev.text) &&
			!startsNewItem(line.text);
		if (wrapped) {
			prev.text = `${prev.text} ${line.text}`;
			continue;
		}
		out.push({ ...line });
	}
	return out;
}

export function parseRecipeText(pages: string[]): TextImportResult {
	const input = emptyRecipeFormInput();
	const raw: Line[] = [];
	pages.forEach((page, i) => {
		for (const line of page.split('\n')) {
			const text = line.replace(/\s+/g, ' ').trim();
			if (text) raw.push({ text, page: i + 1 });
		}
	});
	const lines = joinWrapped(raw);
	if (!lines.length) return { input, ingredientPages: [], empty: true };

	input.notes = pages.map((p) => p.trim()).join('\n\n');

	// Title: the first line that is not itself a heading or a stat.
	const titleIndex = lines.findIndex(
		(l) =>
			!INGREDIENT_HEADING.test(l.text) &&
			!STEP_HEADING.test(l.text) &&
			!SERVINGS.test(l.text) &&
			!SERVINGS_TRAILING.test(l.text)
	);
	if (titleIndex >= 0) input.title = lines[titleIndex].text.slice(0, 200);

	let section: 'none' | 'ingredients' | 'steps' | 'other' = 'none';
	const ingredientPages: number[] = [];
	const steps: RecipeStepInput[] = [];
	const descriptionParts: string[] = [];

	lines.forEach((line, i) => {
		const { text } = line;
		if (INGREDIENT_HEADING.test(text)) return void (section = 'ingredients');
		if (STEP_HEADING.test(text)) return void (section = 'steps');
		if (OTHER_HEADING.test(text)) return void (section = 'other');
		if (i === titleIndex) return;

		// Stats can appear anywhere; take them wherever they show up.
		const servings = SERVINGS.exec(text) ?? SERVINGS_TRAILING.exec(text);
		if (servings && !input.baseServings) {
			input.baseServings = servings[1];
			return;
		}
		const prep = PREP.exec(text);
		if (prep && !input.prepMinutes) {
			const mins = timeToMinutes(prep[1]);
			if (mins !== null) {
				input.prepMinutes = String(mins);
				return;
			}
		}
		const cook = COOK.exec(text);
		if (cook && !input.cookMinutes) {
			const mins = timeToMinutes(cook[1]);
			if (mins !== null) {
				input.cookMinutes = String(mins);
				return;
			}
		}
		if (section === 'other') return;

		const split = splitIngredientLine(text);
		const looksLikeIngredient = !!split.amount;
		const inIngredients = section === 'ingredients';
		const inSteps = section === 'steps';

		if (inSteps || (section === 'none' && !looksLikeIngredient && steps.length)) {
			// The form numbers steps itself, so drop the source's own numbering.
			steps.push({ section: '', text: text.replace(NUMBERED, '') });
			return;
		}
		if (inIngredients || looksLikeIngredient) {
			input.ingredients.push({
				name: split.name,
				ingredientId: null,
				amount: split.amount,
				unit: split.unit,
				preparation: split.name === split.original ? '' : split.original,
				group: '',
				optional: false,
				createIdentity: false
			});
			ingredientPages.push(line.page);
			return;
		}
		// Prose before any heading reads as the description; after that, a step.
		if (section === 'none' && !input.ingredients.length && !steps.length)
			descriptionParts.push(text);
		else steps.push({ section: '', text: text.replace(NUMBERED, '') });
	});

	input.description = descriptionParts.join(' ').slice(0, 2000);
	input.steps = steps;
	return { input, ingredientPages, empty: false };
}
