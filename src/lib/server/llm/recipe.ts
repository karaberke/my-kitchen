import { z } from 'zod';
import { AppError } from '$lib/server/errors';
import {
	emptyRecipeFormInput,
	ingredientFromLine,
	servingsFromYield,
	stripTags
} from '$lib/shared/recipe-html';
import { timeToMinutes } from '$lib/shared/recipe-text';
import { ingredientLine } from '$lib/shared/ingredient-line';
import { isEmptyRecipe, type RecipeFormInput } from '$lib/shared/recipe-input';
import { normalizeName } from '$lib/shared/text';
import { claimLlmCall, completeJson, llmEnabled, type LlmCallOptions } from './client';
import {
	RECIPE_JSON_SYSTEM,
	RECIPE_PARSE_TASK,
	RECIPE_TIDY_TASK,
	SCRIPT_DATA_HEADING
} from './prompts';

/**
 * Text sent to the model is cut here: about 3k tokens, which leaves room in the
 * 8192-token context for the prompt and a 1500-token reply.
 */
export const LLM_MAX_INPUT_CHARS = 12_000;
/** A recipe as JSON. At about 19 tokens a second this is also about the time limit. */
export const LLM_RECIPE_MAX_TOKENS = 1500;

/** Rows kept from one reply, the same bound the import payload uses. */
const MAX_ROWS = 200;

/**
 * What the model returns. Every value is a string: the model copies text, and
 * code reads amounts, units, servings and times out of it.
 */
export const modelRecipeSchema = z.object({
	title: z.string(),
	description: z.string(),
	servings: z.string(),
	prepMinutes: z.string(),
	cookMinutes: z.string(),
	ingredients: z.array(z.string()),
	steps: z.array(z.string()),
	notes: z.string()
});

export type ModelRecipe = z.infer<typeof modelRecipeSchema>;

/** A script line that is code, not data: DOM and method calls, functions, string building, markup. */
const SCRIPT_CODE_LINE =
	/\b(document|window|function|return|addEventListener|getAttribute|querySelector|innerHTML|localStorage)\b|=>|\+=|\.\w+\(|["'`]\s*\+|\+\s*["'`]|["'`]\s*</;
/** A script line with a quoted word in it, such as `[2/3, "cup", "heavy cream"]`. */
const SCRIPT_DATA_LINE = /["'`][^"'`]*[A-Za-z]{3}/;

/**
 * Lines that look like data in the page's inline scripts. Some recipe pages
 * hold their ingredients and steps in a script and draw them in the browser,
 * so the visible text alone has no recipe in it.
 */
function scriptDataLines(html: string): string[] {
	const lines: string[] = [];
	for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
		if (/\bsrc\s*=/i.test(m[1])) continue;
		for (const line of m[2].split('\n')) {
			const t = line.trim();
			if (SCRIPT_DATA_LINE.test(t) && !SCRIPT_CODE_LINE.test(t)) lines.push(t);
		}
	}
	return lines;
}

/**
 * Source text made small enough for the model: no scripts, styles, menus,
 * headers, footers, sidebars or buttons, no markup, block elements as line breaks,
 * no runs of blank lines, and at most `LLM_MAX_INPUT_CHARS` characters.
 * Data lines from inline scripts follow the visible text, which goes first.
 */
export function cleanSourceText(raw: string): string {
	const html = raw
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(
			/<(script|style|nav|header|footer|aside|noscript|svg|form|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
			' '
		)
		.replace(/<\/(p|li|div|h[1-6]|section|article|tr|ul|ol)\s*>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n');
	const visible = stripTags(html)
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	const data = scriptDataLines(raw);
	const text = data.length ? `${visible}\n\n${SCRIPT_DATA_HEADING}\n${data.join('\n')}` : visible;
	return text.slice(0, LLM_MAX_INPUT_CHARS).trim();
}

/** A recipe form as the plain text the model tidies. */
export function formInputToPlainText(input: RecipeFormInput): string {
	const lines: string[] = [input.title.trim()];
	if (input.description.trim()) lines.push('', input.description.trim());
	const meta: string[] = [];
	if (input.baseServings.trim()) meta.push(`Serves ${input.baseServings.trim()}`);
	if (input.yieldNote.trim()) meta.push(`Makes ${input.yieldNote.trim()}`);
	if (input.prepMinutes.trim()) meta.push(`Prep ${input.prepMinutes.trim()} minutes`);
	if (input.cookMinutes.trim()) meta.push(`Cook ${input.cookMinutes.trim()} minutes`);
	if (meta.length) lines.push('', meta.join('. '));
	lines.push('', 'Ingredients:');
	for (const i of input.ingredients) {
		if (!i.name.trim()) continue;
		const quantity = [i.amount.trim(), i.unit.trim()].filter(Boolean).join(' ');
		lines.push(
			`- ${ingredientLine({ quantity, name: i.name.trim(), preparation: i.preparation })}`
		);
	}
	lines.push('', 'Steps:');
	input.steps
		.filter((s) => s.text.trim())
		.forEach((s, idx) => lines.push(`${idx + 1}. ${s.text.trim()}`));
	if (input.notes.trim()) lines.push('', 'Notes:', input.notes.trim());
	return lines.join('\n').slice(0, LLM_MAX_INPUT_CHARS);
}

function clean(s: string, max: number): string {
	return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

function minutes(raw: string): string {
	const m = timeToMinutes(raw);
	return m === null ? '' : String(m);
}

/**
 * The model's reply as form input, on top of `base`.
 *
 * Ingredient lines go through `splitIngredientLine`, so the model never decides
 * an amount or a unit. A row whose name matches a row in `base` keeps that
 * row's pantry link, group and optional flag. A value the model left empty
 * keeps the value from `base`.
 */
export function recipeFromModel(
	out: ModelRecipe,
	base: RecipeFormInput = emptyRecipeFormInput()
): RecipeFormInput {
	const byName = new Map(base.ingredients.map((i) => [normalizeName(i.name), i]));
	const ingredients = out.ingredients
		.map((line) => clean(line, 300))
		.filter(Boolean)
		.slice(0, MAX_ROWS)
		.map((line) => {
			const row = ingredientFromLine(line);
			const known = byName.get(normalizeName(row.name));
			return known
				? {
						...row,
						ingredientId: known.ingredientId,
						proposed: known.proposed,
						group: known.group,
						optional: known.optional
					}
				: row;
		});
	const steps = out.steps
		.map((text) => clean(text.replace(/^\s*(?:step\s*)?\d+[.):]\s*/i, ''), 4000))
		.filter(Boolean)
		.slice(0, MAX_ROWS)
		.map((text) => ({ section: '', text }));
	const servings = servingsFromYield(clean(out.servings, 200));
	return {
		...base,
		title: clean(out.title, 200) || base.title,
		description: clean(out.description, 4000) || base.description,
		baseServings: servings.baseServings || base.baseServings,
		yieldNote: servings.yieldNote || base.yieldNote,
		prepMinutes: minutes(out.prepMinutes) || base.prepMinutes,
		cookMinutes: minutes(out.cookMinutes) || base.cookMinutes,
		notes: out.notes.trim().slice(0, 8000) || base.notes,
		ingredients: ingredients.length ? ingredients : base.ingredients,
		steps: steps.length ? steps : base.steps
	};
}

/**
 * Read a recipe out of text the app could not read itself. `base` supplies the
 * values the model does not return (link, picture, a title found on the page);
 * its notes are dropped, because there they hold the whole page.
 */
export async function llmParseRecipe(
	text: string,
	base: RecipeFormInput = emptyRecipeFormInput(),
	call: LlmCallOptions = {}
): Promise<RecipeFormInput> {
	const source = cleanSourceText(text);
	if (!source) throw new AppError(422, 'There is no text the assistant can read.');
	const out = await completeJson(
		modelRecipeSchema,
		RECIPE_JSON_SYSTEM,
		RECIPE_PARSE_TASK + source,
		{
			maxTokens: LLM_RECIPE_MAX_TOKENS,
			name: 'recipe',
			...call
		}
	);
	return recipeFromModel(out, { ...base, notes: '' });
}

/** A tidied copy of a recipe form. Only a proposal: nothing is saved here. */
export async function fixRecipe(
	input: RecipeFormInput,
	call: LlmCallOptions = {}
): Promise<RecipeFormInput> {
	if (isEmptyRecipe(input) && !input.title.trim())
		throw new AppError(422, 'There is no recipe to tidy yet.');
	const out = await completeJson(
		modelRecipeSchema,
		RECIPE_JSON_SYSTEM,
		RECIPE_TIDY_TASK + formInputToPlainText(input),
		{ maxTokens: LLM_RECIPE_MAX_TOKENS, name: 'recipe', ...call }
	);
	return recipeFromModel(out, input);
}

export interface AssistedImport {
	input: RecipeFormInput;
	/** true when the assistant's reading replaced the app's */
	assisted: boolean;
	/** why the assistant did not help, safe to show; null when it did or was not asked */
	assistantError: string | null;
}

export interface ImportAssistArgs {
	input: RecipeFormInput;
	/** the user asked for the assistant even though the app read the recipe */
	forced: boolean;
	/** the raw source; read only when the parse is empty */
	sourceText: () => Promise<string>;
}

/**
 * True when an import asks for the assistant: it is set up, and the app's own
 * parse found no ingredients and no steps, or the user asked for it.
 */
export function assistWanted(input: RecipeFormInput, forced: boolean): boolean {
	return llmEnabled() && (forced || isEmptyRecipe(input));
}

/** What the assistant does for one import: read `source`, or tidy `base` when `source` is null. */
export interface AssistPlan {
	base: RecipeFormInput;
	source: string | null;
}

/**
 * The assistant's work for an import, or `skip` with the message to show
 * (null for none) when there is nothing for it to do. Spends no quota. An
 * empty parse sends the cleaned source text; a full parse sends the recipe as
 * read, to tidy.
 */
export async function planAssist(
	args: ImportAssistArgs
): Promise<{ plan: AssistPlan } | { skip: string | null }> {
	if (!assistWanted(args.input, args.forced)) return { skip: null };
	if (!isEmptyRecipe(args.input)) return { plan: { base: args.input, source: null } };
	const source = cleanSourceText(await args.sourceText());
	if (!source) return { skip: args.forced ? 'There is no text the assistant can read.' : null };
	return { plan: { base: args.input, source } };
}

/** Message for a failure that is not an `AppError`; its detail is never shown. */
const ASSIST_FAILED = 'The assistant could not read this recipe.';

function assistFailure(err: unknown): string {
	if (err instanceof AppError) return err.message;
	console.warn('llm: import assist failed', err instanceof Error ? err.name : typeof err);
	return ASSIST_FAILED;
}

/**
 * Run a plan whose call was already claimed. It never throws: a failure
 * leaves `plan.base` and a message.
 */
export async function runAssist(
	plan: AssistPlan,
	call: LlmCallOptions = {}
): Promise<AssistedImport> {
	try {
		const input =
			plan.source !== null
				? await llmParseRecipe(plan.source, plan.base, call)
				: await fixRecipe(plan.base, call);
		return { input, assisted: true, assistantError: null };
	} catch (err) {
		return { input: plan.base, assisted: false, assistantError: assistFailure(err) };
	}
}

/**
 * The assistant's part in an import, start to end, while the caller waits:
 * `planAssist`, then the quota, then `runAssist`. It never fails the import:
 * any failure leaves the app's own result and a message.
 */
export async function assistImport(
	userId: string,
	args: ImportAssistArgs
): Promise<AssistedImport> {
	const unchanged = { input: args.input, assisted: false, assistantError: null };
	try {
		const planned = await planAssist(args);
		if ('skip' in planned) return { ...unchanged, assistantError: planned.skip };
		claimLlmCall(userId);
		return await runAssist(planned.plan);
	} catch (err) {
		return { ...unchanged, assistantError: assistFailure(err) };
	}
}
