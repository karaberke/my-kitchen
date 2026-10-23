import {
	emptyRecipeFormInput,
	servingsFromYield,
	type RecipeFormInput,
	type RecipeStepInput
} from './recipe-input';
import {
	ingredientRowsFromLine,
	splitIngredientLine,
	type SplitIngredient
} from './ingredient-line';
import { collapseSpaces } from './text';

/**
 * Best-effort reading of a recipe out of plain text — the shape you get from a
 * PDF's text layer. Layout is lost by then, so this leans on the words that
 * recipes almost always use, and never invents a value it cannot see.
 */

const INGREDIENT_HEADING = /^(ingredients|you will need|shopping list)\b[:\s]*$/i;
const STEP_HEADING = /^(method|instructions|directions|steps|preparation)\b[:\s]*$/i;
const OTHER_HEADING = /^(notes?|tips?|nutrition|equipment)\b[:\s]*$/i;

/** Semantic HTML headings use the same section names as plain-text imports. */
export function recipeSectionOf(text: string): 'ingredients' | 'steps' | 'other' | null {
	if (INGREDIENT_HEADING.test(text)) return 'ingredients';
	if (STEP_HEADING.test(text)) return 'steps';
	return OTHER_HEADING.test(text) ? 'other' : null;
}

const SERVINGS_TRAILING = /^(\d+(?:\.\d+)?)\s+servings?\b/i;
const META_LABEL =
	'prep(?:aration)?(?:\\s+time)?|cook(?:ing)?(?:\\s+time)?|bake(?:\\s+time)?|total(?:\\s+time)?|serves|servings?|yield|makes';
const METADATA_START = new RegExp(`^(?:${META_LABEL})(?:\\s*:|\\s+|$)`, 'i');
const METADATA_ONLY = new RegExp(`^(?:${META_LABEL})\\s*:?$`, 'i');
const METADATA_EXPLICIT = new RegExp(`^(?:${META_LABEL})\\s*:`, 'i');

export function isRecipeMetadataLabel(text: string): boolean {
	return METADATA_ONLY.test(text.trim());
}
const LABELLED = /^[^:]{1,100}:/;
export const RECIPE_SOURCE = /^source\s*:\s*(https?:\/\/\S+)\s*$/im;

/** Explicit metadata only; instruction prose and total time never become cook time. */
function readMetadata(text: string, input: RecipeFormInput): boolean {
	const trailing = SERVINGS_TRAILING.exec(text);
	if (trailing) {
		input.baseServings ||= trailing[1];
		return true;
	}
	if (!METADATA_START.test(text)) return false;
	const labels = [...text.matchAll(new RegExp(`\\b(${META_LABEL})\\b\\s*:?\\s*`, 'gi'))];
	let found = false;
	labels.forEach((match, i) => {
		const value = text
			.slice(match.index + match[0].length, labels[i + 1]?.index)
			.replace(/[|;•]+\s*$/, '')
			.trim();
		const label = match[1].toLowerCase();
		if (!value || (!/^\d/.test(value) && !/^(?:yield|makes)/.test(label))) return;
		if (/^(?:serv|yield|makes)/.test(label)) {
			const parsed = servingsFromYield(value);
			input.baseServings ||= parsed.baseServings;
			input.yieldNote ||= parsed.yieldNote;
			found = true;
			return;
		}
		const minutes = timeToMinutes(value);
		if (minutes === null) return;
		if (label.startsWith('prep')) input.prepMinutes ||= String(minutes);
		if (/^(?:cook|bake)/.test(label)) input.cookMinutes ||= String(minutes);
		found = true;
	});
	return found;
}

/** "1 hr 30 min", "45 minutes", "1h30" -> minutes. */
export function timeToMinutes(raw: string): number | null {
	const s = raw.trim().toLowerCase().replace(/\.$/, '');
	const hours =
		/^(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?:\s*,?\s*(?:and\s+)?(\d+)\s*(?:minutes?|mins?|m)?)?$/.exec(
			s
		);
	if (hours) return Math.round(Number(hours[1]) * 60 + Number(hours[2] ?? 0));
	const minutes = /^(\d+)\s*(?:minutes?|mins?|m)?$/.exec(s);
	return minutes ? Number(minutes[1]) : null;
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
	/** `splitIngredientLine(text)`, kept until `text` changes */
	split?: SplitIngredient;
}

function splitOf(line: Line): SplitIngredient {
	line.split ??= splitIngredientLine(line.text);
	return line.split;
}

const NUMBERED = /^(?:\d+[.)]\s+|step\s+\d+\s*[:.)-]?\s*)/i;

/** A line that plainly begins something new, so the one before it is finished. */
function startsNewItem(line: Line): boolean {
	const { text } = line;
	return (
		NUMBERED.test(text) ||
		INGREDIENT_HEADING.test(text) ||
		STEP_HEADING.test(text) ||
		OTHER_HEADING.test(text) ||
		METADATA_START.test(text) ||
		LABELLED.test(text) ||
		!!splitOf(line).amount
	);
}

/**
 * PDF text arrives wrapped at the page's column width, so one sentence can span
 * several lines. Re-join a line onto the one before when that one clearly had
 * not finished — but never across something that starts a new item.
 */
function joinWrapped(lines: Line[]): Line[] {
	const out: Line[] = [];
	let inSteps = false;
	let numberedStep = false;
	for (const line of lines) {
		const prev = out[out.length - 1];
		if (prev && /^source\s*:\s*$/i.test(prev.text) && /^https?:\/\/\S+$/i.test(line.text)) {
			prev.text = `${prev.text} ${line.text}`;
			prev.split = undefined;
			continue;
		}
		if (STEP_HEADING.test(line.text)) {
			inSteps = true;
			numberedStep = false;
		} else if (INGREDIENT_HEADING.test(line.text) || OTHER_HEADING.test(line.text)) {
			inSteps = false;
			numberedStep = false;
		} else if (inSteps && NUMBERED.test(line.text)) {
			numberedStep = true;
		} else if (
			inSteps &&
			numberedStep &&
			prev &&
			!LABELLED.test(line.text) &&
			!METADATA_ONLY.test(line.text)
		) {
			// An explicitly numbered step can contain several sentences and short
			// wrapped lines; its next number or heading is the reliable boundary.
			prev.text = `${prev.text} ${line.text}`;
			prev.split = undefined;
			continue;
		} else if (inSteps && (LABELLED.test(line.text) || METADATA_ONLY.test(line.text)))
			numberedStep = false;
		if (
			prev &&
			METADATA_ONLY.test(prev.text) &&
			(/^\d/.test(line.text) || (/^(?:yield|makes)\b/i.test(prev.text) && !startsNewItem(line)))
		) {
			prev.text = `${prev.text}: ${line.text}`;
			prev.split = undefined;
			continue;
		}
		const wrapped =
			prev &&
			// Only a line long enough to have hit the column edge was wrapped; a
			// short one is a title or a label that simply has no full stop.
			((prev.text.length >= 45 && !/[.!?:;]$/.test(prev.text)) ||
				(NUMBERED.test(prev.text) && /:$/.test(prev.text))) &&
			!METADATA_START.test(prev.text) &&
			!startsNewItem(line);
		if (wrapped) {
			prev.text = `${prev.text} ${line.text}`;
			prev.split = undefined;
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
			const text = collapseSpaces(line);
			if (text) raw.push({ text, page: i + 1 });
		}
	});
	const lines = joinWrapped(raw);
	if (!lines.length) return { input, ingredientPages: [], empty: true };
	const hasIngredientHeading = lines.some((line) => INGREDIENT_HEADING.test(line.text));

	input.notes = pages.map((p) => p.trim()).join('\n\n');

	// Title: the first line that is not itself a heading or a stat.
	const titleIndex = lines.findIndex(
		(l) =>
			!INGREDIENT_HEADING.test(l.text) &&
			!STEP_HEADING.test(l.text) &&
			!METADATA_START.test(l.text) &&
			!SERVINGS_TRAILING.test(l.text)
	);
	if (titleIndex >= 0) input.title = lines[titleIndex].text.slice(0, 200);

	let section: 'none' | 'ingredients' | 'steps' | 'other' = 'none';
	const ingredientPages: number[] = [];
	const steps: RecipeStepInput[] = [];
	const descriptionParts: string[] = [];
	let ingredientGroup = '';

	lines.forEach((line, i) => {
		const { text } = line;
		if (INGREDIENT_HEADING.test(text)) return void (section = 'ingredients');
		if (STEP_HEADING.test(text)) return void (section = 'steps');
		if (OTHER_HEADING.test(text)) return void (section = 'other');
		if (i === titleIndex) return;
		const source = RECIPE_SOURCE.exec(text);
		if (source) {
			input.source ||= source[1];
			return;
		}
		if ((section === 'none' || METADATA_EXPLICIT.test(text)) && readMetadata(text, input)) return;
		if (section === 'other') return;
		if (section === 'ingredients' && /^[^:]{1,100}:$/.test(text)) {
			ingredientGroup = text.slice(0, -1).trim();
			return;
		}

		const split = splitOf(line);
		const looksLikeIngredient =
			!!split.amount && (!hasIngredientHeading || section === 'ingredients');
		const inIngredients = section === 'ingredients';
		const inSteps = section === 'steps';

		if (inSteps || (section === 'none' && !looksLikeIngredient && steps.length)) {
			// The form numbers steps itself, so drop the source's own numbering.
			steps.push({ section: '', text: text.replace(NUMBERED, '') });
			return;
		}
		if (inIngredients || looksLikeIngredient) {
			for (const ingredient of ingredientRowsFromLine(text)) {
				input.ingredients.push({ ...ingredient, group: ingredient.group || ingredientGroup });
				ingredientPages.push(line.page);
			}
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
