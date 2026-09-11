import { z } from 'zod';
import type { RecipeFormInput } from '$lib/shared/recipe-input';

/**
 * Shape check for a recipe the browser parsed for us.
 *
 * This is not a trust boundary — the payload only prefills the review form, and
 * the real rules run in validateRecipe() when the user saves. What it does is
 * bound the shape and size, so a malformed or oversized post is rejected cleanly
 * instead of being spread into the form.
 */
const str = (max: number) => z.string().max(max).catch('');

const ingredient = z.object({
	name: str(200),
	ingredientId: z.string().uuid().nullable().catch(null),
	amount: str(40),
	unit: str(40),
	preparation: str(200),
	group: str(100),
	optional: z.boolean().catch(false),
	createIdentity: z.boolean().catch(false)
});

const step = z.object({ section: str(120), text: str(4000) });

export const importedRecipeSchema = z.object({
	source: z.enum(['json-ld', 'text', 'pdf', 'pdf-empty']),
	pageCount: z.number().int().min(0).max(10_000).nullable().catch(null),
	input: z.object({
		title: str(200),
		description: str(4000),
		baseServings: str(40),
		yieldNote: str(200),
		prepMinutes: str(20),
		cookMinutes: str(20),
		source: str(500),
		notes: str(8000),
		tags: str(500),
		convention: str(20),
		ingredients: z.array(ingredient).max(200).catch([]),
		steps: z.array(step).max(200).catch([]),
		// Only prefills the field. The server downloads it when the user saves, and
		// the user can see it and clear it first.
		imageUrl: str(2000)
	})
});

export type ImportedRecipe = {
	source: 'json-ld' | 'text' | 'pdf' | 'pdf-empty';
	pageCount: number | null;
	input: RecipeFormInput;
};

/** Returns null when the payload is absent or unusable, so the caller parses server-side. */
export function readImportedRecipe(raw: FormDataEntryValue | null): ImportedRecipe | null {
	if (typeof raw !== 'string' || !raw || raw.length > 1_000_000) return null;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const result = importedRecipeSchema.safeParse(json);
	if (!result.success) return null;
	const { source, pageCount, input } = result.data;
	return {
		source,
		pageCount,
		// The fields the form needs but the browser has no business choosing.
		input: { ...input, intent: 'save', expectedRevision: null, removeImage: false }
	};
}
