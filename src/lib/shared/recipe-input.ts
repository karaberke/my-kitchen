import { Dec } from './decimal';
import { parseAmount } from './amount-parse';
import { isUnitId, normalizeUnitInput, type Convention } from './units';

export type RecipeIntent = 'draft' | 'save';

export interface RecipeIngredientInput {
	name: string;
	ingredientId: string | null;
	amount: string;
	unit: string;
	preparation: string;
	group: string;
	optional: boolean;
	/** user confirmed “create this as my own ingredient” */
	createIdentity: boolean;
	/** the app filled the link itself; the form shows it as a proposal to refuse */
	proposed?: boolean;
}

export interface RecipeStepInput {
	section: string;
	text: string;
}

export interface RecipeFormInput {
	title: string;
	description: string;
	baseServings: string;
	yieldNote: string;
	prepMinutes: string;
	cookMinutes: string;
	source: string;
	notes: string;
	tags: string;
	convention: string;
	ingredients: RecipeIngredientInput[];
	steps: RecipeStepInput[];
	intent: RecipeIntent;
	expectedRevision: number | null;
	removeImage: boolean;
	/** A picture named by a link. The server downloads it; it is never hotlinked. */
	imageUrl: string;
}

export interface ValidIngredient {
	position: number;
	name: string;
	ingredientId: string | null;
	createIdentity: boolean;
	amount: Dec | null;
	unit: string | null;
	preparation: string;
	groupName: string;
	optional: boolean;
}

export interface ValidStep {
	position: number;
	sectionTitle: string;
	text: string;
}

export interface ValidRecipe {
	title: string;
	description: string;
	baseServings: Dec | null;
	yieldNote: string;
	prepMinutes: number | null;
	cookMinutes: number | null;
	source: string;
	notes: string;
	tags: string[];
	convention: Convention;
	status: 'draft' | 'active';
	ingredients: ValidIngredient[];
	steps: ValidStep[];
}

export type FieldErrors = Record<string, string>;

export type RecipeValidation =
	{ ok: true; value: ValidRecipe; errors: FieldErrors } | { ok: false; errors: FieldErrors };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function str(fd: FormData, key: string, max = 4000): string {
	const v = fd.get(key);
	return typeof v === 'string' ? v.slice(0, max) : '';
}

/** Parse indexed form fields (ing.0.name, step.2.text ...) into a structured input. Order = index order. */
export function parseRecipeForm(fd: FormData): RecipeFormInput {
	const ingIdx = new Set<number>();
	const stepIdx = new Set<number>();
	for (const key of fd.keys()) {
		const mi = /^ing\.(\d+)\./.exec(key);
		if (mi) ingIdx.add(Number(mi[1]));
		const ms = /^step\.(\d+)\./.exec(key);
		if (ms) stepIdx.add(Number(ms[1]));
	}
	const ingredients = [...ingIdx]
		.sort((a, b) => a - b)
		.slice(0, 200)
		.map((i) => ({
			name: str(fd, `ing.${i}.name`, 200),
			ingredientId: str(fd, `ing.${i}.ingredientId`, 64) || null,
			amount: str(fd, `ing.${i}.amount`, 32),
			unit: str(fd, `ing.${i}.unit`, 32),
			preparation: str(fd, `ing.${i}.preparation`, 300),
			group: str(fd, `ing.${i}.group`, 100),
			optional: fd.get(`ing.${i}.optional`) === 'on' || fd.get(`ing.${i}.optional`) === 'true',
			createIdentity: fd.get(`ing.${i}.createIdentity`) === '1'
		}));
	const steps = [...stepIdx]
		.sort((a, b) => a - b)
		.slice(0, 200)
		.map((i) => ({
			section: str(fd, `step.${i}.section`, 100),
			text: str(fd, `step.${i}.text`, 4000)
		}));
	const revisionRaw = str(fd, 'expectedRevision', 16);
	return {
		title: str(fd, 'title', 200),
		description: str(fd, 'description', 4000),
		baseServings: str(fd, 'baseServings', 16),
		yieldNote: str(fd, 'yieldNote', 200),
		prepMinutes: str(fd, 'prepMinutes', 8),
		cookMinutes: str(fd, 'cookMinutes', 8),
		source: str(fd, 'source', 500),
		notes: str(fd, 'notes', 8000),
		tags: str(fd, 'tags', 500),
		convention: str(fd, 'convention', 10) || 'metric',
		ingredients,
		steps,
		intent: str(fd, 'intent', 10) === 'draft' ? 'draft' : 'save',
		expectedRevision: /^\d+$/.test(revisionRaw) ? Number(revisionRaw) : null,
		removeImage: fd.get('removeImage') === 'on' || fd.get('removeImage') === 'true',
		// Trimmed here: a pasted address almost always carries a space or a newline.
		imageUrl: str(fd, 'imageUrl', 2000).trim()
	};
}

function parseMinutes(raw: string, key: string, errors: FieldErrors): number | null {
	const s = raw.trim();
	if (!s) return null;
	if (!/^\d{1,4}$/.test(s)) {
		errors[key] = 'Enter whole minutes';
		return null;
	}
	return Number(s);
}

export function parseTags(raw: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of raw.split(/[,\n]/)) {
		const t = part.trim().replace(/\s+/g, ' ').slice(0, 40);
		const key = t.toLowerCase();
		if (!t || seen.has(key)) continue;
		seen.add(key);
		out.push(t);
		if (out.length >= 20) break;
	}
	return out;
}

/**
 * Validate a recipe. Drafts may be incomplete; a "save" must have title,
 * positive servings, at least one ingredient and one step. Amounts and units
 * must always parse so nothing ambiguous is stored.
 */
export function validateRecipe(input: RecipeFormInput): RecipeValidation {
	const errors: FieldErrors = {};
	const draft = input.intent === 'draft';
	const title = input.title.trim().replace(/\s+/g, ' ');
	if (!title && !draft) errors.title = 'Give the recipe a title';
	if (title.length > 200) errors.title = 'Keep the title under 200 characters';

	let baseServings: Dec | null = null;
	const servingsRaw = input.baseServings.trim();
	if (servingsRaw) {
		const parsed = parseAmount(servingsRaw);
		if (!parsed.ok || parsed.value === null || !parsed.value.isPositive())
			errors.baseServings = 'Servings must be a positive number';
		else if (parsed.value.gt(Dec.from(1000)))
			errors.baseServings = 'Servings must be 1000 or fewer';
		else baseServings = parsed.value;
	} else if (!draft) {
		errors.baseServings = 'Base servings are needed for scaling';
	}

	const prepMinutes = parseMinutes(input.prepMinutes, 'prepMinutes', errors);
	const cookMinutes = parseMinutes(input.cookMinutes, 'cookMinutes', errors);
	const convention: Convention = input.convention === 'us' ? 'us' : 'metric';

	const ingredients: ValidIngredient[] = [];
	input.ingredients.forEach((row, i) => {
		const name = row.name.trim().replace(/\s+/g, ' ');
		const blank = !name && !row.amount.trim() && !row.unit.trim() && !row.preparation.trim();
		if (blank) return;
		if (!name) errors[`ing.${i}.name`] = 'Name this ingredient';
		let amount: Dec | null = null;
		const parsed = parseAmount(row.amount);
		if (!parsed.ok) errors[`ing.${i}.amount`] = parsed.error;
		else amount = parsed.value;
		let unit: string | null = null;
		const unitRaw = row.unit.trim();
		if (unitRaw) {
			const norm = isUnitId(unitRaw) ? unitRaw : normalizeUnitInput(unitRaw);
			if (!norm) errors[`ing.${i}.unit`] = 'Unknown unit';
			else unit = norm;
		}
		if (row.ingredientId && !UUID_RE.test(row.ingredientId))
			errors[`ing.${i}.ingredientId`] = 'Invalid ingredient reference';
		ingredients.push({
			position: ingredients.length,
			name,
			ingredientId: row.ingredientId && UUID_RE.test(row.ingredientId) ? row.ingredientId : null,
			createIdentity: !row.ingredientId && row.createIdentity,
			amount,
			unit,
			preparation: row.preparation.trim(),
			groupName: row.group.trim(),
			optional: row.optional
		});
	});
	if (ingredients.length === 0 && !draft) errors.ingredients = 'Add at least one ingredient';

	const steps: ValidStep[] = [];
	input.steps.forEach((row) => {
		const text = row.text.trim();
		if (!text) return;
		steps.push({ position: steps.length, sectionTitle: row.section.trim(), text });
	});
	if (steps.length === 0 && !draft) errors.steps = 'Add at least one step';

	if (Object.keys(errors).length) return { ok: false, errors };
	return {
		ok: true,
		errors,
		value: {
			title: title || 'Untitled draft',
			description: input.description.trim(),
			baseServings,
			yieldNote: input.yieldNote.trim(),
			prepMinutes,
			cookMinutes,
			source: input.source.trim(),
			notes: input.notes.trim(),
			tags: parseTags(input.tags),
			convention,
			status: draft ? 'draft' : 'active',
			ingredients,
			steps
		}
	};
}

/** Whether a stored recipe has everything needed for grocery generation and cooking. */
export function recipeIsCookable(recipe: {
	status: string;
	baseServings: string | null;
	ingredientCount: number;
}): boolean {
	return (
		recipe.status === 'active' &&
		recipe.baseServings !== null &&
		Dec.from(recipe.baseServings).isPositive() &&
		recipe.ingredientCount > 0
	);
}
