import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUser, makeChickenRecipe, requestAs, resetDb, type TestUser } from './helpers';
import { AppError } from '$lib/server/errors';
import { askAboutRecipe } from '$lib/server/llm/ask';
import { LLM_LIMITS, resetRateLimits } from '$lib/server/ratelimit';
import { LLM_QUESTION_MAX_CHARS } from '$lib/shared/recipe-input';
import { actions } from '../../src/routes/(app)/recipes/import/+page.server';
import { stubLlm, unstubLlm } from '../llm-stub';
import { setLlmForTests } from '$lib/server/llm/client';
import type { RequestEvent } from '@sveltejs/kit';

let alice: TestUser;
let bob: TestUser;

beforeEach(async () => {
	await resetDb();
	resetRateLimits();
	alice = await createUser('Alice');
	bob = await createUser('Bob');
});
afterEach(unstubLlm);

const ANSWER = 'Yes, you can swap it.';

describe('askAboutRecipe', () => {
	it('answers about the cook’s own recipe, with its title and the question in the prompt', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Lemon chicken bake', '500');
		const { requests } = stubLlm([ANSWER]);
		const out = await askAboutRecipe(requestAs(alice), {
			recipeId,
			question: 'Can I use thighs instead?'
		});
		expect(out).toEqual({ answer: ANSWER });
		expect(requests).toHaveLength(1);
		const userMessage = requests[0].messages.at(-1)!;
		expect(userMessage.role).toBe('user');
		expect(userMessage.content).toContain('LEMON CHICKEN BAKE');
		expect(userMessage.content).toContain('chicken breast');
		expect(userMessage.content).toContain('Question: Can I use thighs instead?');
	});

	it('is a 404 for another cook’s private recipe, and never calls the model or spends quota', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Secret stew', '300');
		const { requests } = stubLlm([ANSWER]);
		const err = await askAboutRecipe(requestAs(bob), { recipeId, question: 'Is it good?' }).catch(
			(e) => e
		);
		expect(err).toBeInstanceOf(AppError);
		expect(err.status).toBe(404);
		expect(requests).toHaveLength(0);
		// Denied asks left every call in Bob's allowance.
		const mine = await makeChickenRecipe(bob, 'Bob soup', '100');
		for (let i = 0; i < LLM_LIMITS.user.max; i++)
			await askAboutRecipe(requestAs(bob), { recipeId: mine, question: 'ok?' });
		expect(requests).toHaveLength(LLM_LIMITS.user.max);
	});

	it('is a 401 for a signed-out caller, with no model call', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Private', '300');
		const { requests } = stubLlm([ANSWER]);
		await expect(
			askAboutRecipe(requestAs(null), { recipeId, question: 'Hi?' })
		).rejects.toMatchObject({ status: 401 });
		expect(requests).toHaveLength(0);
	});

	it('is a 400 for a blank question, and cuts a long one to the limit', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Quick chicken', '300');
		const { requests } = stubLlm([ANSWER]);
		await expect(
			askAboutRecipe(requestAs(alice), { recipeId, question: '  \n\t ' })
		).rejects.toMatchObject({ status: 400 });
		expect(requests).toHaveLength(0);
		await askAboutRecipe(requestAs(alice), {
			recipeId,
			question: 'x'.repeat(LLM_QUESTION_MAX_CHARS + 200)
		});
		const sent = requests[0].messages.at(-1)!.content;
		expect(sent.endsWith(`Question: ${'x'.repeat(LLM_QUESTION_MAX_CHARS)}`)).toBe(true);
	});

	it('is a 503 when the assistant is off', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Off chicken', '300');
		setLlmForTests({ config: null });
		await expect(
			askAboutRecipe(requestAs(alice), { recipeId, question: 'Hi?' })
		).rejects.toMatchObject({ status: 503 });
	});

	it('is a 429 after the allowed calls in the window', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Busy chicken', '300');
		stubLlm([ANSWER]);
		for (let i = 0; i < LLM_LIMITS.user.max; i++)
			await askAboutRecipe(requestAs(alice), { recipeId, question: 'Hi?' });
		await expect(
			askAboutRecipe(requestAs(alice), { recipeId, question: 'Hi?' })
		).rejects.toMatchObject({ status: 429 });
	});

	it('is a 502 when the model gives an empty answer', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Quiet chicken', '300');
		stubLlm(['']);
		await expect(
			askAboutRecipe(requestAs(alice), { recipeId, question: 'Hi?' })
		).rejects.toMatchObject({ status: 502 });
	});
});

/* The import route's parse action, called with a real form body. */

const JSON_LD_PAGE = `<html><head><title>Dal page</title>
<script type="application/ld+json">${JSON.stringify({
	'@context': 'https://schema.org',
	'@type': 'Recipe',
	name: 'Red lentil dal',
	recipeIngredient: ['200 g red lentils', '1 onion'],
	recipeInstructions: ['Simmer the lentils.', 'Fry the onion.']
})}</script></head><body><p>Dal.</p></body></html>`;

const PLAIN_PAGE = `<html><head><title>My blog</title></head><body>
<nav>Menu</nav><h1>Grandma's pancakes</h1>
<p>Mix 200 g flour with 2 eggs and fry.</p></body></html>`;

const MODEL_RECIPE = JSON.stringify({
	title: "Grandma's pancakes",
	description: '',
	servings: '4',
	prepMinutes: '',
	cookMinutes: '',
	ingredients: ['200 g flour', '2 eggs'],
	steps: ['Mix and fry.'],
	notes: ''
});

interface ParseResult {
	parsed: boolean;
	source: string;
	assistantError: string | null;
	input: {
		title: string;
		ingredients: { name: string; amount: string; unit: string }[];
		steps: { text: string }[];
	};
}

async function parse(user: TestUser, fields: Record<string, string>): Promise<ParseResult> {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const base = requestAs(user);
	const event = {
		...base,
		request: new Request('http://localhost/recipes/import?/parse', { method: 'POST', body })
	} as RequestEvent;
	return (await actions.parse!(event as never)) as unknown as ParseResult;
}

describe('import: parse action with the assistant', () => {
	it('does not call the model for a page the app reads itself', async () => {
		const { requests } = stubLlm([MODEL_RECIPE]);
		const out = await parse(alice, { html: JSON_LD_PAGE });
		expect(requests).toHaveLength(0);
		expect(out.source).toBe('json-ld');
		expect(out.assistantError).toBeNull();
		expect(out.input.ingredients.map((i) => i.name)).toEqual(['red lentils', 'onion']);
	});

	it('calls the model for a page with no structured recipe, and marks the source', async () => {
		const { requests } = stubLlm([MODEL_RECIPE]);
		const out = await parse(alice, { html: PLAIN_PAGE });
		expect(requests).toHaveLength(1);
		expect(requests[0].messages.at(-1)!.content).toContain('Mix 200 g flour');
		expect(requests[0].messages.at(-1)!.content).not.toContain('Menu');
		expect(out.source).toBe('assistant');
		expect(out.assistantError).toBeNull();
		expect(out.input.title).toBe("Grandma's pancakes");
		expect(out.input.ingredients[0]).toMatchObject({ amount: '200', unit: 'g', name: 'flour' });
		expect(out.input.steps.map((s) => s.text)).toEqual(['Mix and fry.']);
	});

	it('calls the model on a page the app read itself when useAssistant is on', async () => {
		const { requests } = stubLlm([
			JSON.stringify({
				title: 'Red lentil dal',
				description: '',
				servings: '',
				prepMinutes: '',
				cookMinutes: '',
				ingredients: ['200 g red lentils', '1 onion'],
				steps: ['Simmer the lentils.', 'Fry the onion, then add it.'],
				notes: ''
			})
		]);
		const out = await parse(alice, { html: JSON_LD_PAGE, useAssistant: 'on' });
		expect(requests).toHaveLength(1);
		expect(out.source).toBe('assistant');
		expect(out.input.steps[1].text).toBe('Fry the onion, then add it.');
	});

	it('returns the app’s own result with a message when the model fails', async () => {
		const { requests } = stubLlm([new TypeError('fetch failed')]);
		const out = await parse(alice, { html: JSON_LD_PAGE, useAssistant: 'on' });
		expect(requests).toHaveLength(1);
		expect(out.parsed).toBe(true);
		expect(out.source).toBe('json-ld');
		expect(typeof out.assistantError).toBe('string');
		expect(out.assistantError).not.toBe('');
		expect(out.input.ingredients.map((i) => i.name)).toEqual(['red lentils', 'onion']);
	});

	it('keeps the plain-text result and a message when an automatic call fails', async () => {
		stubLlm(['not json', 'still not json']);
		const out = await parse(alice, { html: PLAIN_PAGE });
		expect(out.source).toBe('text');
		expect(out.assistantError).toEqual(expect.any(String));
		expect(out.input.title).toBe('My blog');
	});

	it('imports as before, with no message, when the assistant is off', async () => {
		setLlmForTests({ config: null });
		const out = await parse(alice, { html: PLAIN_PAGE, useAssistant: 'on' });
		expect(out.source).toBe('text');
		expect(out.assistantError).toBeNull();
	});
});
