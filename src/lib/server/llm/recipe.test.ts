import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLM_LIMITS, resetRateLimits } from '$lib/server/ratelimit';
import { emptyRecipeFormInput } from '$lib/shared/recipe-html';
import type { RecipeFormInput } from '$lib/shared/recipe-input';
import { stubLlm, unstubLlm } from '../../../../tests/llm-stub';
import { setLlmForTests } from './client';
import {
	LLM_MAX_INPUT_CHARS,
	assistImport,
	cleanSourceText,
	formInputToPlainText,
	llmParseRecipe,
	recipeFromModel,
	type ModelRecipe
} from './recipe';

const model = (over: Partial<ModelRecipe> = {}): ModelRecipe => ({
	title: 'Red lentil dal',
	description: '',
	servings: '',
	prepMinutes: '',
	cookMinutes: '',
	ingredients: [],
	steps: [],
	notes: '',
	...over
});

const modelReply = (over: Partial<ModelRecipe> = {}) => JSON.stringify(model(over));

function fullInput(): RecipeFormInput {
	return {
		...emptyRecipeFormInput(),
		title: 'Pancakes',
		ingredients: [
			{
				name: 'flour',
				ingredientId: 'ing-1',
				amount: '200',
				unit: 'g',
				preparation: '',
				group: '',
				optional: false,
				createIdentity: false
			}
		],
		steps: [{ section: '', text: 'Mix and fry.' }]
	};
}

const USER = 'user-1';
const sourceText = vi.fn(async () => '<html><body><p>Some page about dal.</p></body></html>');

beforeEach(() => {
	resetRateLimits();
	sourceText.mockClear();
});
afterEach(unstubLlm);

describe('cleanSourceText', () => {
	it('drops scripts, styles, menus, headers, footers and sidebars with their content', () => {
		const out = cleanSourceText(`
			<html><head><style>.a { color: red }</style><script>var secret = 1;</script></head>
			<body>
			<header>SITE HEADER</header><nav><a href="/">Home MENU</a></nav>
			<main><h1>Dal</h1><p>Cook the <b>lentils</b>.</p></main>
			<aside>SIDEBAR ADVERT</aside><footer>FOOTER LEGAL</footer>
			</body></html>`);
		for (const gone of ['color: red', 'secret', 'SITE HEADER', 'MENU', 'SIDEBAR', 'FOOTER'])
			expect(out).not.toContain(gone);
		expect(out).not.toMatch(/[<>]/);
		expect(out).toContain('Dal');
		expect(out).toContain('Cook the lentils');
	});

	it('puts block elements on their own lines and collapses runs of blank lines and spaces', () => {
		const out = cleanSourceText('<ul><li>one</li><li>two</li></ul>\n\n\n\n\n<p>three     four</p>');
		expect(out).not.toMatch(/\n{3,}/);
		expect(out).not.toMatch(/ {2,}/);
		const lines = out.split('\n').filter(Boolean);
		expect(lines).toEqual(['one', 'two', 'three four']);
	});

	it('cuts the text to the limit', () => {
		const out = cleanSourceText(`<p>${'word '.repeat(LLM_MAX_INPUT_CHARS)}</p>`);
		expect(out.length).toBeLessThanOrEqual(LLM_MAX_INPUT_CHARS);
		expect(out.length).toBeGreaterThan(LLM_MAX_INPUT_CHARS - 10);
	});

	it('returns an empty string for a page with only markup', () => {
		expect(cleanSourceText('<nav>Menu</nav><script>x()</script>')).toBe('');
		expect(cleanSourceText('')).toBe('');
	});
});

describe('formInputToPlainText', () => {
	it('lists the title, ingredients with amounts and numbered steps, and skips blank rows', () => {
		const input = fullInput();
		input.ingredients.push({ ...input.ingredients[0], name: '  ', amount: '5' });
		input.steps.push({ section: '', text: '   ' });
		const text = formInputToPlainText(input);
		expect(text).toContain('Pancakes');
		expect(text).toContain('- 200 g flour');
		expect(text).toContain('1. Mix and fry.');
		expect(text).not.toContain('5');
		expect(text).not.toContain('2.');
	});
});

describe('recipeFromModel', () => {
	it('splits an ingredient line into amount, unit and name in code', () => {
		const out = recipeFromModel(model({ ingredients: ['2 tbsp olive oil'] }));
		expect(out.ingredients).toHaveLength(1);
		expect(out.ingredients[0]).toMatchObject({ amount: '2', unit: 'tbsp', name: 'olive oil' });
	});

	it('parses servings and times from text', () => {
		const out = recipeFromModel(
			model({ servings: '4 servings', prepMinutes: '15 minutes', cookMinutes: '1 hour 30 minutes' })
		);
		expect(out.baseServings).toBe('4');
		expect(out.prepMinutes).toBe('15');
		expect(out.cookMinutes).toBe('90');
	});

	it('keeps a yield that is not a number as a note, and ignores a time it cannot read', () => {
		const out = recipeFromModel(model({ servings: 'one loaf', prepMinutes: 'a while' }));
		expect(out.baseServings).toBe('');
		expect(out.yieldNote).toBe('one loaf');
		expect(out.prepMinutes).toBe('');
	});

	it('removes step numbers and drops blank steps and blank ingredient lines', () => {
		const out = recipeFromModel(
			model({ ingredients: ['  ', '1 onion'], steps: ['1. Chop.', ' ', 'Step 2: Fry.'] })
		);
		expect(out.ingredients.map((i) => i.name)).toEqual(['onion']);
		expect(out.steps.map((s) => s.text)).toEqual(['Chop.', 'Fry.']);
	});

	it('keeps the link, group and flags of a row whose name is already in the base', () => {
		const base = fullInput();
		base.ingredients[0] = { ...base.ingredients[0], group: 'Batter', optional: true };
		const out = recipeFromModel(model({ ingredients: ['250 g flour', '1 egg'] }), base);
		expect(out.ingredients[0]).toMatchObject({
			name: 'flour',
			amount: '250',
			ingredientId: 'ing-1',
			group: 'Batter',
			optional: true
		});
		expect(out.ingredients[1]).toMatchObject({ name: 'egg', ingredientId: null });
	});

	it('keeps the values of the base where the model left a field empty', () => {
		const base = { ...fullInput(), description: 'From the page', notes: 'My note' };
		const out = recipeFromModel(
			model({ title: '', description: '', notes: '', ingredients: [], steps: [] }),
			base
		);
		expect(out.title).toBe('Pancakes');
		expect(out.description).toBe('From the page');
		expect(out.notes).toBe('My note');
		expect(out.ingredients).toEqual(base.ingredients);
		expect(out.steps).toEqual(base.steps);
	});
});

describe('llmParseRecipe', () => {
	it('sends cleaned text, builds the form from the reply and drops the base notes', async () => {
		const { requests } = stubLlm([
			modelReply({ ingredients: ['200 g red lentils'], steps: ['Simmer.'], servings: '4' })
		]);
		const base = {
			...emptyRecipeFormInput(),
			imageUrl: 'https://example.com/a.jpg',
			notes: 'PAGE'
		};
		const out = await llmParseRecipe('<nav>Menu</nav><p>Dal recipe</p>', base);
		const sent = requests[0].messages.at(-1)!.content;
		expect(sent).toContain('Dal recipe');
		expect(sent).not.toContain('Menu');
		expect(out.imageUrl).toBe('https://example.com/a.jpg');
		expect(out.notes).toBe('');
		expect(out.ingredients[0]).toMatchObject({ amount: '200', unit: 'g', name: 'red lentils' });
	});

	it('is a 422 without calling the model when there is no text', async () => {
		const { requests } = stubLlm([modelReply()]);
		await expect(llmParseRecipe('<script>x()</script>')).rejects.toMatchObject({ status: 422 });
		expect(requests).toHaveLength(0);
	});
});

describe('assistImport', () => {
	it('does not call the model for a full recipe that was not forced', async () => {
		const { requests } = stubLlm([modelReply()]);
		const input = fullInput();
		const out = await assistImport(USER, { input, forced: false, sourceText });
		expect(requests).toHaveLength(0);
		expect(sourceText).not.toHaveBeenCalled();
		expect(out).toEqual({ input, assisted: false, assistantError: null });
	});

	it('reads the source text with the model when the parse found nothing', async () => {
		const { requests } = stubLlm([
			modelReply({
				title: 'Red lentil dal',
				ingredients: ['200 g red lentils'],
				steps: ['Simmer for 20 minutes.']
			})
		]);
		const out = await assistImport(USER, {
			input: emptyRecipeFormInput(),
			forced: false,
			sourceText
		});
		expect(requests).toHaveLength(1);
		expect(requests[0].messages.at(-1)!.content).toContain('Some page about dal.');
		expect(out.assisted).toBe(true);
		expect(out.assistantError).toBeNull();
		expect(out.input.title).toBe('Red lentil dal');
		expect(out.input.ingredients.map((i) => i.name)).toEqual(['red lentils']);
		expect(out.input.steps.map((s) => s.text)).toEqual(['Simmer for 20 minutes.']);
	});

	it('treats a parse with only blank rows or notes as empty', async () => {
		const { requests } = stubLlm([modelReply({ ingredients: ['1 egg'] })]);
		const input = { ...emptyRecipeFormInput(), notes: 'A whole page of text' };
		const out = await assistImport(USER, { input, forced: false, sourceText });
		expect(requests).toHaveLength(1);
		expect(out.assisted).toBe(true);
	});

	it('tidies a full recipe when forced, sending the recipe as read', async () => {
		const { requests } = stubLlm([modelReply({ ingredients: ['200 g flour'], steps: ['Mix.'] })]);
		const out = await assistImport(USER, { input: fullInput(), forced: true, sourceText });
		expect(requests).toHaveLength(1);
		const sent = requests[0].messages.at(-1)!.content;
		expect(sent).toContain('Pancakes');
		expect(sent).toContain('Mix and fry.');
		// The page is not read again: the app's own reading is what gets tidied.
		expect(sourceText).not.toHaveBeenCalled();
		expect(out.assisted).toBe(true);
		expect(out.input.steps.map((s) => s.text)).toEqual(['Mix.']);
		expect(out.input.ingredients[0].ingredientId).toBe('ing-1');
	});

	it('returns the original input and a message when the model fails', async () => {
		stubLlm([new TypeError('fetch failed')]);
		const input = emptyRecipeFormInput();
		const out = await assistImport(USER, { input, forced: false, sourceText });
		expect(out.assisted).toBe(false);
		expect(out.input).toBe(input);
		expect(typeof out.assistantError).toBe('string');
		expect(out.assistantError).not.toBe('');
	});

	it('returns the original input and a message when the reply is unreadable twice', async () => {
		stubLlm(['nonsense', 'still nonsense']);
		const input = fullInput();
		const out = await assistImport(USER, { input, forced: true, sourceText });
		expect(out).toMatchObject({ input, assisted: false });
		expect(out.assistantError).toEqual(expect.any(String));
	});

	it('does nothing and says nothing when the assistant is off', async () => {
		setLlmForTests({ config: null });
		const input = emptyRecipeFormInput();
		for (const forced of [false, true]) {
			const out = await assistImport(USER, { input, forced, sourceText });
			expect(out).toEqual({ input, assisted: false, assistantError: null });
		}
		expect(sourceText).not.toHaveBeenCalled();
	});

	it('explains when forced on a page that has no readable text, and stays quiet when not forced', async () => {
		const { requests } = stubLlm([modelReply()]);
		const blank = async () => '<script>x()</script>';
		const input = emptyRecipeFormInput();
		const quiet = await assistImport(USER, { input, forced: false, sourceText: blank });
		expect(quiet).toEqual({ input, assisted: false, assistantError: null });
		const forced = await assistImport(USER, { input, forced: true, sourceText: blank });
		expect(forced.assisted).toBe(false);
		expect(forced.assistantError).toEqual(expect.any(String));
		expect(requests).toHaveLength(0);
	});

	it('keeps the import working and reports the limit when the user is out of calls', async () => {
		const { requests } = stubLlm([modelReply({ ingredients: ['1 egg'] })]);
		const input = emptyRecipeFormInput();
		for (let i = 0; i < LLM_LIMITS.user.max; i++)
			await assistImport(USER, { input, forced: false, sourceText });
		expect(requests).toHaveLength(LLM_LIMITS.user.max);
		const out = await assistImport(USER, { input, forced: false, sourceText });
		expect(requests).toHaveLength(LLM_LIMITS.user.max);
		expect(out.assisted).toBe(false);
		expect(out.assistantError).toMatch(/too many/i);
		expect(out.input).toBe(input);
	});
});
