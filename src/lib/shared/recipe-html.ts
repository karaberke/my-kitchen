import type { RecipeFormInput, RecipeIngredientInput, RecipeStepInput } from './recipe-input';
import { parseAmount } from './amount-parse';
import { isUnitId, normalizeUnitInput } from './units';

/**
 * Read a recipe out of a saved HTML page.
 *
 * The HTML is only ever parsed for text: it is never stored as markup, never
 * rendered, and never executed. Script and style contents are dropped before
 * any text is taken, so nothing from the source can reach the page as markup.
 */

export type ImportSource = 'json-ld' | 'text';

export interface HtmlImportResult {
	source: ImportSource;
	input: RecipeFormInput;
}

/** "PT1H30M" -> 90. Anything unreadable is left for the user to fill in. */
export function isoDurationToMinutes(value: string | undefined | null): number | null {
	if (!value) return null;
	const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?/.exec(value.trim());
	if (!m || (!m[1] && !m[2])) return null;
	return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	mdash: '—',
	ndash: '–',
	hellip: '…',
	frac12: '½',
	frac14: '¼',
	frac34: '¾',
	deg: '°'
};

function decodeEntities(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&([a-z][a-z0-9]*);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** Strip markup to plain text. Script and style contents go first, not just their tags. */
function stripTags(html: string): string {
	const withoutCode = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ');
	return decodeEntities(withoutCode.replace(/<[^>]*>/g, ' '))
		.replace(/[ \t\r\f\v]+/g, ' ')
		.replace(/\s*\n\s*/g, '\n')
		.trim();
}

/** Block-level markup becomes line breaks, so one HTML blob yields separate steps. */
function blocksToLines(html: string): string[] {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
		.replace(/<\/(p|li|div|h[1-6]|section)\s*>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		.split('\n')
		.map((part) => stripTags(part))
		.filter(Boolean);
}

function text(value: unknown): string {
	if (typeof value === 'string') return stripTags(value);
	if (typeof value === 'number') return String(value);
	if (value && typeof value === 'object') {
		const o = value as Record<string, unknown>;
		if (typeof o.text === 'string') return stripTags(o.text);
		if (typeof o.name === 'string') return stripTags(o.name);
	}
	return '';
}

function typesOf(node: Record<string, unknown>): string[] {
	const t = node['@type'];
	if (typeof t === 'string') return [t];
	if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
	return [];
}

/** Walk a JSON-LD document (object, array, or @graph) for the first Recipe node. */
function findRecipe(node: unknown, depth = 0): Record<string, unknown> | null {
	if (!node || depth > 6) return null;
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = findRecipe(item, depth + 1);
			if (found) return found;
		}
		return null;
	}
	if (typeof node !== 'object') return null;
	const obj = node as Record<string, unknown>;
	if (typesOf(obj).includes('Recipe')) return obj;
	for (const key of ['@graph', 'mainEntity', 'itemListElement']) {
		const found = findRecipe(obj[key], depth + 1);
		if (found) return found;
	}
	return null;
}

function jsonLdBlocks(html: string): unknown[] {
	const out: unknown[] = [];
	const re =
		/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		try {
			out.push(JSON.parse(m[1].trim()));
		} catch {
			// A malformed block is skipped; the next one, or the text fallback, still works.
		}
	}
	return out;
}

const VULGAR_CLASS = '[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]';

/**
 * Leading quantity: "200", "1.5", "1,5", "1/2", "1 1/2", "½", "1½", "2-3".
 * Longest forms first, so "1½" is not read as a bare "1".
 */
const QUANTITY = new RegExp(
	'^(' +
		[
			`\\d+\\s*${VULGAR_CLASS}`, // 1½
			'\\d+\\s+\\d+/\\d+', // 1 1/2
			'\\d+/\\d+', // 1/2
			VULGAR_CLASS, // ½
			'\\d+(?:[.,]\\d+)?(?:\\s*[-–—]\\s*\\d+(?:[.,]\\d+)?)?' // 200, 1.5, 2-3
		].join('|') +
		')\\s*'
);

/** Map a free-text unit token to a canonical unit id, or null. */
function normalizeUnit(raw: string): string | null {
	if (!raw) return null;
	return isUnitId(raw.toLowerCase()) ? raw.toLowerCase() : normalizeUnitInput(raw);
}

export interface SplitIngredient {
	amount: string;
	unit: string;
	name: string;
	/** the line exactly as the source wrote it */
	original: string;
}

/**
 * Split "200 g red lentils" into amount, unit and name so imported recipes can
 * scale and match the pantry like hand-entered ones. Anything it cannot read
 * confidently stays in the name — it never guesses a quantity.
 */
export function splitIngredientLine(line: string): SplitIngredient {
	const original = line.trim().replace(/\s+/g, ' ');
	const empty = { amount: '', unit: '', name: original, original };
	if (!original) return { ...empty, name: '' };

	const m = QUANTITY.exec(original);
	if (!m) return empty;

	// A range ("2-3 tbsp") keeps its low end, which is the safe amount to shop for.
	const quantityRaw = m[1].split(/\s*[-–—]\s*/)[0];
	const parsed = parseAmount(quantityRaw);
	if (!parsed.ok || parsed.value === null) return empty;

	let rest = original.slice(m[0].length).trim();
	let unit = '';
	// "fl oz" is two words; try the longer token first.
	for (const words of [2, 1]) {
		const candidate = rest.split(' ').slice(0, words).join(' ');
		if (!candidate) continue;
		const norm = normalizeUnit(candidate);
		if (norm) {
			unit = norm;
			rest = rest.split(' ').slice(words).join(' ').trim();
			break;
		}
	}
	rest = rest.replace(/^of\s+/i, '').trim();

	let amount = parsed.value.toString();
	// "1 can (400 ml) coconut milk": the parenthesised measure is the one worth
	// tracking, so it wins over the container count.
	const paren = /^\(\s*([^)]+?)\s*\)\s*/.exec(rest);
	if (paren) {
		const inner = QUANTITY.exec(paren[1]);
		const innerAmount = inner
			? parseAmount(inner[1].split(/\s*[-–—]\s*/)[0])
			: ({ ok: false } as const);
		// Only when the brackets hold exactly a measure, e.g. "(400 ml)".
		const innerUnit = inner ? normalizeUnit(paren[1].slice(inner[0].length).trim()) : null;
		if (inner && innerAmount.ok && innerAmount.value !== null && innerUnit) {
			amount = innerAmount.value.toString();
			unit = innerUnit;
			rest = rest.slice(paren[0].length).trim();
		}
	}

	// Without a name there is nothing to track; keep the line as written.
	if (!rest) return empty;
	return { amount, unit, name: rest, original };
}

function ingredient(line: string): RecipeIngredientInput {
	const split = splitIngredientLine(line);
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

/** Flatten HowToStep / HowToSection / plain strings into ordered steps. */
function instructionsToSteps(value: unknown, section = '', depth = 0): RecipeStepInput[] {
	if (!value || depth > 4) return [];
	if (typeof value === 'string') {
		return blocksToLines(value).map((t) => ({ section, text: t }));
	}
	if (Array.isArray(value)) return value.flatMap((v) => instructionsToSteps(v, section, depth + 1));
	if (typeof value === 'object') {
		const o = value as Record<string, unknown>;
		if (typesOf(o).includes('HowToSection')) {
			const name = text(o.name);
			return instructionsToSteps(o.itemListElement, name, depth + 1);
		}
		const t = text(o);
		return t ? [{ section, text: t }] : [];
	}
	return [];
}

function firstScalar(value: unknown): string {
	if (Array.isArray(value)) return value.length ? firstScalar(value[0]) : '';
	return text(value);
}

function titleFromDocument(html: string): string {
	const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
	if (title && stripTags(title[1])) return stripTags(title[1]);
	const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
	return h1 ? stripTags(h1[1]) : '';
}

export function emptyRecipeFormInput(): RecipeFormInput {
	return {
		title: '',
		description: '',
		baseServings: '',
		yieldNote: '',
		prepMinutes: '',
		cookMinutes: '',
		source: '',
		notes: '',
		tags: '',
		convention: 'metric',
		ingredients: [],
		steps: [],
		intent: 'save',
		expectedRevision: null,
		removeImage: false
	};
}

export function importRecipeHtml(html: string): HtmlImportResult {
	const input = emptyRecipeFormInput();
	if (!html.trim()) return { source: 'text', input };

	for (const block of jsonLdBlocks(html)) {
		const recipe = findRecipe(block);
		if (!recipe) continue;

		input.title = text(recipe.name) || titleFromDocument(html);
		input.description = text(recipe.description);
		const prep = isoDurationToMinutes(firstScalar(recipe.prepTime));
		const cook = isoDurationToMinutes(firstScalar(recipe.cookTime));
		if (prep !== null) input.prepMinutes = String(prep);
		if (cook !== null) input.cookMinutes = String(cook);

		// A yield like "4 servings" gives a servings count; "one loaf" is kept as a note.
		const yieldText = firstScalar(recipe.recipeYield);
		const servings = /^\s*(\d+(?:\.\d+)?)\b/.exec(yieldText);
		if (servings) input.baseServings = servings[1];
		else if (yieldText) input.yieldNote = yieldText;

		const ingredients = recipe.recipeIngredient ?? recipe.ingredients;
		if (Array.isArray(ingredients))
			input.ingredients = ingredients
				.map((i) => text(i))
				.filter(Boolean)
				.map(ingredient);

		input.steps = instructionsToSteps(recipe.recipeInstructions);
		return { source: 'json-ld', input };
	}

	// No structured recipe: keep the readable text so nothing is lost, and let
	// the user shape it in the form.
	input.title = titleFromDocument(html);
	input.notes = stripTags(html);
	return { source: 'text', input };
}
