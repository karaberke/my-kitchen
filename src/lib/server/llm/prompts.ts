/**
 * Fixed prompts for the assistant.
 *
 * Nothing is interpolated into these. The model server caches the prompt
 * prefix, so the system prompt and the task line stay byte-for-byte the same
 * on every call, and the recipe text always comes last in the user message.
 *
 * The model is small and bad at arithmetic, so no prompt asks it to scale,
 * convert or add up. Ingredient lines come back as written, and code parses them.
 */

/** One system prompt for every structured recipe call, so its prefix is cached once. */
export const RECIPE_JSON_SYSTEM = `You turn recipe text into JSON for a recipe app.
Rules:
- Use only what the text says. Never invent an ingredient, an amount, a time or a step.
- Copy every amount and unit exactly as written. Do not convert, scale, round or add up.
- "ingredients": one string per ingredient, as the source writes it, with its amount and unit first, for example "200 g red lentils" or "2 tbsp olive oil, chopped".
- "steps": one string per step, in order, without step numbers.
- "servings": the servings or yield as written, for example "4" or "1 loaf". Empty if not given.
- "prepMinutes" and "cookMinutes": the times as written, for example "1 hour 30 minutes". Empty if not given.
- "description": one or two sentences from the text that describe the dish. Empty if there are none.
- "notes": tips, storage or substitutions from the text. Empty if there are none.
- Ignore navigation, adverts, comments, life stories and anything that is not the recipe.
- If the text holds no recipe, return empty strings and empty lists.`;

/** Task line for a page the app could not read: the user message starts with it. */
export const RECIPE_PARSE_TASK = 'Task: read the recipe in this text.\n\nText:\n';

/** Task line for a recipe the app already read: the user message starts with it. */
export const RECIPE_TIDY_TASK = `Task: tidy this recipe. Fix spelling, split joined steps, join broken lines and move stray text to notes. Keep every ingredient and every amount unchanged.

Recipe:
`;

export const RECIPE_ASK_SYSTEM = `You answer one question about one recipe for a home cook.
Rules:
- Answer in plain text, in at most five short sentences. No markdown, no lists of more than five items.
- Use the recipe below and general cooking knowledge. Say so when the recipe does not tell.
- Do not do arithmetic on amounts. If the cook asks to scale or convert, tell them the app's servings control does this.
- If the question is not about cooking or this recipe, say that you can only help with this recipe.`;

/** Start of the user message for a question; the recipe follows, and the question comes last. */
export const RECIPE_ASK_TASK = 'Recipe:\n';
