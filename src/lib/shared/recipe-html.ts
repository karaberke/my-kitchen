import {
	emptyRecipeFormInput,
	servingsFromYield,
	type RecipeFormInput,
	type RecipeStepInput
} from './recipe-input';
import { ingredientRowsFromLine } from './ingredient-line';
import {
	isRecipeMetadataLabel,
	parseRecipeText,
	RECIPE_SOURCE,
	recipeSectionOf,
	timeToMinutes
} from './recipe-text';

export { emptyRecipeFormInput, servingsFromYield } from './recipe-input';

/**
 * Read a recipe out of a saved HTML page.
 *
 * The HTML is only ever parsed for text: it is never stored as markup, never
 * rendered, and never executed. Script and style contents are dropped before
 * any text is taken, so nothing from the source can reach the page as markup.
 */

/** 'assistant': the AI assistant read the source; its amounts need a check. */
export type ImportSource = 'json-ld' | 'text' | 'assistant';

export interface HtmlImportResult {
	/** The page parser itself never answers 'assistant'. */
	source: Exclude<ImportSource, 'assistant'>;
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

/** A numeric character reference, or the literal text when it names no character. */
function codePoint(whole: string, value: number): string {
	// String.fromCodePoint throws RangeError outside 0..0x10FFFF and on surrogates,
	// which turned a malformed source page into a 500 during import.
	if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff) return whole;
	if (value >= 0xd800 && value <= 0xdfff) return whole;
	return String.fromCodePoint(value);
}

function decodeEntities(s: string): string {
	return s
		.replace(/&#(\d+);/g, (whole, n) => codePoint(whole, Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (whole, n) => codePoint(whole, parseInt(n, 16)))
		.replace(/&([a-z][a-z0-9]*);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** Strip markup to plain text. Script and style contents go first, not just their tags. */
export function stripTags(html: string): string {
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
		.replace(/<\/(p|li|div|h[1-6]|section|dt|dd|tr|td|th)\s*>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		.split('\n')
		.map((part) => stripTags(part))
		.filter(Boolean);
}

/** Preserve table orientation and nested ingredient headings before stripping markup. */
function recipeLayoutText(html: string): string {
	const tables = html.replace(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi, (_, table: string) => {
		const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((row) =>
			[...row[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((cell) => ({
				header: cell[1].toLowerCase() === 'th',
				text: stripTags(cell[2])
			}))
		);
		const [head, values] = rows;
		if (!rows.some((row) => row.length)) return table;
		if (
			rows.length === 2 &&
			head.length > 0 &&
			head.length === values.length &&
			head.every((cell) => cell.header && isRecipeMetadataLabel(cell.text))
		)
			return `\n${head.map((cell, i) => `${cell.text.replace(/:$/, '')}: ${values[i].text}`).join('\n')}\n`;
		return `\n${rows
			.filter((row) => row.some((cell) => !cell.header))
			.map((row) => row.map((cell) => cell.text).join(' '))
			.join('\n')}\n`;
	});
	let ingredientLevel: number | null = null;
	return tables.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (whole, level, content) => {
		const text = stripTags(content);
		const section = recipeSectionOf(text);
		if (section) ingredientLevel = section === 'ingredients' ? Number(level) : null;
		else if (ingredientLevel !== null) {
			if (Number(level) > ingredientLevel)
				return `<h${level}>${content.replace(/:\s*$/, '')}:</h${level}>`;
			ingredientLevel = null;
		}
		return whole;
	});
}

function plainRecipeInput(html: string, pageImage: string, pageUrl?: string): RecipeFormInput {
	const body = html.replace(/<(head|nav|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
	const readable = blocksToLines(body).join('\n');
	const region = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(body)?.[2];
	const recipeBody = (region ?? body).replace(
		/<footer\b[^>]*>([\s\S]*?)<\/footer\s*>/gi,
		(_, content) => {
			const source = blocksToLines(content).join(' ');
			return /^source\s*:\s*https?:\/\/\S+\s*$/i.test(source) ? `\n${source}\n` : '';
		}
	);
	const parsed = parseRecipeText([blocksToLines(recipeLayoutText(recipeBody)).join('\n')]).input;
	const headings = [...recipeBody.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)];
	for (let i = 0; i < headings.length; i++) {
		const heading = headings[i];
		if (recipeSectionOf(stripTags(heading[2])) !== 'steps') continue;
		const end = headings.slice(i + 1).find((next) => Number(next[1]) <= Number(heading[1]))?.index;
		const content = recipeBody.slice(heading.index + heading[0].length, end);
		const list = /<(ol|ul)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(content);
		if (!list) continue;
		const steps = [...list[2].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)]
			.map((item) => stripTags(item[1]))
			.filter(Boolean);
		if (steps.length) parsed.steps = steps.map((text) => ({ section: '', text }));
		break;
	}
	parsed.title = (region && titleFromDocument(region)) || titleFromDocument(html) || parsed.title;
	parsed.source ||= RECIPE_SOURCE.exec(readable)?.[1] ?? pageUrl ?? '';
	parsed.imageUrl = absoluteImageUrl(pageImage, pageUrl);
	parsed.notes = readable.length <= MAX_USEFUL_NOTES ? readable : '';
	return parsed;
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

/**
 * The recipe's own name beats the document title, which usually carries the
 * site's name too ("Taiwanese Fried Chicken - The Woks of Life").
 */
function titleFromDocument(html: string): string {
	const named =
		/<[a-z0-9]+\b[^>]*class="[^"]*recipe-name[^"]*"[^>]*>([\s\S]*?)<\/[a-z0-9]+\s*>/i.exec(html) ??
		/<[a-z0-9]+\b[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/[a-z0-9]+\s*>/i.exec(html);
	if (named && stripTags(named[1])) return stripTags(named[1]);
	const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
	if (title && stripTags(title[1])) return stripTags(title[1]);
	const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
	return h1 ? stripTags(h1[1]) : '';
}

/**
 * Past this, the text is a whole web page — navigation, comments, footer — not
 * a recipe. Keeping it would bury the useful part and be truncated on save
 * anyway, so the stored original becomes the better reference.
 */
const MAX_USEFUL_NOTES = 4000;

/**
 * The picture a page names, as an absolute http(s) address, or ''.
 *
 * This runs in the browser too, so it throws nothing: an address that cannot be
 * used is simply not offered. A `data:` URI is dropped for the same reason —
 * the server downloads the picture, and there is nothing to download.
 */
function absoluteImageUrl(raw: string, pageUrl?: string): string {
	const value = decodeEntities(raw).trim();
	if (!value) return '';
	try {
		const url = new URL(value, pageUrl);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
	} catch {
		return '';
	}
}

/** The content of the first of these meta tags the page carries. */
function metaContent(html: string, keys: string[]): string {
	for (const key of keys) {
		const tag = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${key}["'][^>]*>`, 'i').exec(
			html
		)?.[0];
		const content = tag ? /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] : '';
		if (content) return content;
	}
	return '';
}

/** schema.org `image`: a string, a list, or an ImageObject. */
function schemaImage(value: unknown): string {
	if (Array.isArray(value)) return value.length ? schemaImage(value[0]) : '';
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') {
		const o = value as Record<string, unknown>;
		if (typeof o.url === 'string') return o.url;
		if (typeof o.contentUrl === 'string') return o.contentUrl;
	}
	return '';
}

export function importRecipeHtml(html: string, pageUrl?: string): HtmlImportResult {
	const input = emptyRecipeFormInput();
	input.source = pageUrl ?? '';
	if (!html.trim()) return { source: 'text', input };

	// The page's own picture, used unless the recipe names a better one.
	const pageImage = metaContent(html, [
		'og:image',
		'og:image:url',
		'twitter:image',
		'twitter:image:src'
	]);

	for (const block of jsonLdBlocks(html)) {
		const recipe = findRecipe(block);
		if (!recipe) continue;

		input.title = text(recipe.name) || titleFromDocument(html);
		input.description = text(recipe.description);
		const prep =
			isoDurationToMinutes(firstScalar(recipe.prepTime)) ??
			timeToMinutes(firstScalar(recipe.prepTime));
		const cook =
			isoDurationToMinutes(firstScalar(recipe.cookTime)) ??
			timeToMinutes(firstScalar(recipe.cookTime));
		if (prep !== null) input.prepMinutes = String(prep);
		if (cook !== null) input.cookMinutes = String(cook);

		const yields = Array.isArray(recipe.recipeYield) ? recipe.recipeYield : [recipe.recipeYield];
		for (const value of new Set(yields.map(text))) {
			const yieldInfo = servingsFromYield(value);
			if (yieldInfo.baseServings && !input.baseServings)
				input.baseServings = yieldInfo.baseServings;
			if (yieldInfo.yieldNote)
				input.yieldNote = [input.yieldNote, yieldInfo.yieldNote].filter(Boolean).join('; ');
		}

		const ingredients = recipe.recipeIngredient ?? recipe.ingredients;
		if (Array.isArray(ingredients))
			input.ingredients = ingredients
				.map((i) => text(i))
				.filter(Boolean)
				.flatMap(ingredientRowsFromLine);

		input.steps = instructionsToSteps(recipe.recipeInstructions);
		if (!input.ingredients.length) {
			// Some pages publish concatenated ingredient strings or incomplete
			// structured data. Prefer intact visible lists over invented splits.
			const visible = plainRecipeInput(html, pageImage, pageUrl);
			if (visible.ingredients.length) {
				input.ingredients = visible.ingredients;
				input.steps = visible.steps.length ? visible.steps : input.steps;
				input.baseServings ||= visible.baseServings;
				input.yieldNote ||= visible.yieldNote;
				input.prepMinutes ||= visible.prepMinutes;
				input.cookMinutes ||= visible.cookMinutes;
				input.notes = visible.notes;
			}
			if (!input.ingredients.length && typeof ingredients === 'string' && ingredients.trim())
				input.ingredients = ingredientRowsFromLine(stripTags(ingredients));
		}
		// The recipe's own picture beats og:image, which is sometimes the site logo.
		input.imageUrl = absoluteImageUrl(schemaImage(recipe.image) || pageImage, pageUrl);
		return { source: 'json-ld', input };
	}

	return { source: 'text', input: plainRecipeInput(html, pageImage, pageUrl) };
}
