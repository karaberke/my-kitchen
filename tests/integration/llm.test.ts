import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import {
	catalogIngredientId,
	createUser,
	d,
	makeChickenRecipe,
	recipeInput,
	requestAs,
	resetDb,
	type TestUser
} from './helpers';
import { db } from '$lib/server/db';
import {
	ingredients as ingredientRows,
	recipeAttachments,
	recipeIngredients,
	recipes,
	recipeSteps
} from '$lib/server/db/schema';
import { AppError, ReviewConflict } from '$lib/server/errors';
import { askAboutRecipe } from '$lib/server/llm/ask';
import { tidyGroceryList } from '$lib/server/llm/grocery';
import { suggestIngredientMatch } from '$lib/server/llm/match';
import {
	LLM_MAX_JOBS_PER_USER,
	dismissAssistantJobFor,
	jobsForUser,
	listAssistantJobs,
	pendingAttachmentIds,
	resetAssistantJobs,
	startImportJob,
	waitForJob,
	type AssistantJobView
} from '$lib/server/llm/jobs';
import {
	addBatch,
	addManualLine,
	createList,
	getListDetail,
	updateLine
} from '$lib/server/grocery';
import { searchIngredients } from '$lib/server/ingredients';
import { createRecipe } from '$lib/server/recipes';
import { cleanupUnreferencedAttachments } from '$lib/server/media/attachments';
import { LLM_LIMITS, resetRateLimits } from '$lib/server/ratelimit';
import { emptyRecipeFormInput } from '$lib/shared/recipe-html';
import { LLM_CHAT_MAX_TURNS, LLM_QUESTION_MAX_CHARS } from '$lib/shared/assistant-limits';
import { actions } from '../../src/routes/(app)/recipes/import/+page.server';
import { actions as groceryActions } from '../../src/routes/(app)/grocery/[listId=uuid]/+page.server';
import { actions as editActions } from '../../src/routes/(app)/recipes/[id=uuid]/edit/+page.server';
import { STUB_LLM_CONFIG, completionResponse, jsonResponse, stubLlm, unstubLlm } from '../llm-stub';
import { claimLlmCall, setLlmForTests } from '$lib/server/llm/client';
import type { RequestEvent } from '@sveltejs/kit';

let alice: TestUser;
let bob: TestUser;

/** Jobs this test started, and the stubs it holds shut: both are settled after each test. */
let startedJobs: string[] = [];
let openGates: (() => void)[] = [];

beforeEach(async () => {
	await resetDb();
	resetRateLimits();
	resetAssistantJobs();
	alice = await createUser('Alice');
	bob = await createUser('Bob');
});
afterEach(async () => {
	// No job may outlive its test, or it would write into the next one's database.
	for (const release of openGates) release();
	await Promise.all(startedJobs.map((id) => waitForJob(id)));
	startedJobs = [];
	openGates = [];
	unstubLlm();
});

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
		for (let i = 0; i < LLM_LIMITS.chat.max; i++)
			await askAboutRecipe(requestAs(bob), { recipeId: mine, question: 'ok?' });
		expect(requests).toHaveLength(LLM_LIMITS.chat.max);
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
		for (let i = 0; i < LLM_LIMITS.chat.max; i++)
			await askAboutRecipe(requestAs(alice), { recipeId, question: 'Hi?' });
		await expect(
			askAboutRecipe(requestAs(alice), { recipeId, question: 'Hi?' })
		).rejects.toMatchObject({ status: 429 });
	});

	it('sends earlier turns as alternating messages, with the recipe once and the new question last', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Lemon chicken bake', '500');
		const { requests } = stubLlm([ANSWER]);
		await askAboutRecipe(requestAs(alice), {
			recipeId,
			question: 'And how long does it bake?',
			history: [
				{ question: 'Can I use thighs?', answer: 'Yes, thighs work.' },
				{ question: 'Should I dice them?', answer: 'Dice them evenly.' }
			]
		});
		const sent = requests[0].messages;
		expect(sent.map((m) => m.role)).toEqual([
			'system',
			'user',
			'assistant',
			'user',
			'assistant',
			'user'
		]);
		expect(sent[1].content).toContain('LEMON CHICKEN BAKE');
		expect(sent[1].content.endsWith('Question: Can I use thighs?')).toBe(true);
		expect(sent[2].content).toBe('Yes, thighs work.');
		expect(sent[3].content).toBe('Question: Should I dice them?');
		expect(sent[4].content).toBe('Dice them evenly.');
		expect(sent[5].content).toBe('Question: And how long does it bake?');
		expect(sent.filter((m) => m.content.includes('LEMON CHICKEN BAKE'))).toHaveLength(1);
	});

	it('sends the same leading messages on the next turn of a chat', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Lemon chicken bake', '500');
		const { requests } = stubLlm(['First answer.', 'Second answer.']);
		const first = await askAboutRecipe(requestAs(alice), { recipeId, question: 'One?' });
		await askAboutRecipe(requestAs(alice), {
			recipeId,
			question: 'Two?',
			history: [{ question: 'One?', answer: first.answer }]
		});
		const [a, b] = requests;
		expect(b.messages[1]).toEqual(a.messages[1]);
		expect(b.messages[2]).toEqual({ role: 'assistant', content: 'First answer.' });
	});

	it('answers a chat with no history exactly as the old single message', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Plain chicken', '500');
		const { requests } = stubLlm([ANSWER]);
		await askAboutRecipe(requestAs(alice), { recipeId, question: 'Is it spicy?' });
		const sent = requests[0].messages;
		expect(sent).toHaveLength(2);
		expect(sent[1].content.startsWith('Recipe:\nPLAIN CHICKEN')).toBe(true);
		expect(sent[1].content.endsWith('\n\nQuestion: Is it spicy?')).toBe(true);
		expect(sent[1].content).not.toContain('On step');
	});

	it('cuts a long history to the newest turns', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Long chat', '500');
		const { requests } = stubLlm([ANSWER]);
		const history = Array.from({ length: LLM_CHAT_MAX_TURNS + 4 }, (_, i) => ({
			question: `old question ${i + 1}`,
			answer: `old answer ${i + 1}`
		}));
		await askAboutRecipe(requestAs(alice), { recipeId, question: 'Now?', history });
		const sent = requests[0].messages;
		expect(sent).toHaveLength(1 + 2 * LLM_CHAT_MAX_TURNS + 1);
		expect(sent[1].content.endsWith('Question: old question 5')).toBe(true);
		expect(sent.some((m) => m.content.includes('old question 4'))).toBe(false);
	});

	it('scales the amounts in the recipe text to the servings asked for', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Scaled chicken', '500', 4);
		const { requests } = stubLlm([ANSWER]);
		await askAboutRecipe(requestAs(alice), { recipeId, question: 'How much?' });
		await askAboutRecipe(requestAs(alice), { recipeId, question: 'How much?', servings: '8' });
		await askAboutRecipe(requestAs(alice), { recipeId, question: 'How much?', servings: '2' });
		const [stored, doubled, halved] = requests.map((r) => r.messages[1].content);
		expect(stored).toContain('Serves 4');
		expect(stored).toContain('500 g chicken breast');
		expect(doubled).toContain('Serves 8');
		expect(doubled).toContain('1000 g chicken breast');
		expect(doubled).not.toContain('500 g');
		expect(halved).toContain('Serves 2');
		expect(halved).toContain('250 g chicken breast');
	});

	it('puts the step note only in the last message, and none for a step out of range', async () => {
		const chicken = await catalogIngredientId('chicken breast');
		const recipeId = await createRecipe(
			alice.id,
			recipeInput({
				title: 'Three step chicken',
				ingredients: [
					{
						position: 0,
						name: 'chicken breast',
						ingredientId: chicken,
						amount: d('500'),
						unit: 'g',
						preparation: '',
						groupName: '',
						optional: false,
						createIdentity: false
					}
				],
				steps: [
					{ position: 0, sectionTitle: '', text: 'Dice.' },
					{ position: 1, sectionTitle: '', text: 'Fry.' },
					{ position: 2, sectionTitle: '', text: 'Serve.' }
				]
			})
		);
		const { requests } = stubLlm([ANSWER]);
		await askAboutRecipe(requestAs(alice), {
			recipeId,
			question: 'How hot?',
			step: 2,
			history: [{ question: 'Why dice?', answer: 'It cooks evenly.' }]
		});
		const sent = requests[0].messages;
		expect(sent.at(-1)!.content).toBe('(On step 2 of 3.) Question: How hot?');
		for (const m of sent.slice(0, -1)) expect(m.content).not.toContain('On step');

		await askAboutRecipe(requestAs(alice), { recipeId, question: 'How hot?', step: 4 });
		await askAboutRecipe(requestAs(alice), { recipeId, question: 'How hot?', step: 0 });
		for (const r of requests.slice(1)) expect(r.messages.at(-1)!.content).not.toContain('On step');
	});

	it('is a 400 for servings that are not a positive number, with no model call or quota spent', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Bad servings', '300');
		const { requests } = stubLlm([ANSWER]);
		for (const servings of ['abc', '0', '-2', '', '1/0'])
			await expect(
				askAboutRecipe(requestAs(alice), { recipeId, question: 'How much?', servings })
			).rejects.toMatchObject({ status: 400 });
		expect(requests).toHaveLength(0);
		for (let i = 0; i < LLM_LIMITS.chat.max; i++)
			await askAboutRecipe(requestAs(alice), { recipeId, question: 'ok?' });
		expect(requests).toHaveLength(LLM_LIMITS.chat.max);
	});

	it('keeps the chat quota apart from the import quota', async () => {
		const recipeId = await makeChickenRecipe(alice, 'Two quotas', '300');
		const { requests } = stubLlm([ANSWER]);
		// Using up the imports leaves the chat open ...
		for (let i = 0; i < LLM_LIMITS.user.max; i++) claimLlmCall(alice.id);
		expect(() => claimLlmCall(alice.id)).toThrow(expect.objectContaining({ status: 429 }));
		for (let i = 0; i < LLM_LIMITS.chat.max; i++)
			await askAboutRecipe(requestAs(alice), { recipeId, question: 'ok?' });
		expect(requests).toHaveLength(LLM_LIMITS.chat.max);
		// ... and using up the chat stops the chat only.
		await expect(
			askAboutRecipe(requestAs(alice), { recipeId, question: 'ok?' })
		).rejects.toMatchObject({ status: 429 });

		// The other way round: a full chat leaves an import open.
		resetRateLimits();
		for (let i = 0; i < LLM_LIMITS.chat.max; i++) claimLlmCall(alice.id, 'chat');
		const out = await parse(alice, { html: PLAIN_PAGE });
		expect(out.assistantError).toBeNull();
		expect(out.assistantJob).not.toBeNull();
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

const modelReply = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		title: "Grandma's pancakes",
		description: '',
		servings: '4',
		prepMinutes: '',
		cookMinutes: '',
		ingredients: ['200 g flour', '2 eggs'],
		steps: ['Mix and fry.'],
		notes: '',
		...over
	});

const MODEL_RECIPE = modelReply();

interface ParseResult {
	parsed: boolean;
	source: string;
	assistantJob: { id: string; title: string } | null;
	assistantError: string | null;
	attachmentId: string;
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
	const out = (await actions.parse!(event as never)) as unknown as ParseResult;
	if (out.assistantJob) startedJobs.push(out.assistantJob.id);
	return out;
}

/** The finished job for an action result; fails the test when no job started. */
async function finished(out: ParseResult): Promise<AssistantJobView> {
	expect(out.assistantJob).not.toBeNull();
	return (await waitForJob(out.assistantJob!.id))!;
}

/**
 * The assistant, answering `reply` only after `release()`: a job that stays
 * running for as long as the test needs. The afterEach hook releases it too.
 */
function gatedLlm(reply: string) {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const requests: unknown[] = [];
	const fetchStub = (async (_url: unknown, init?: RequestInit) => {
		requests.push(JSON.parse(String(init?.body)));
		await gate;
		return completionResponse(reply);
	}) as typeof fetch;
	setLlmForTests({ config: STUB_LLM_CONFIG, fetch: fetchStub });
	openGates.push(release);
	return { release, requests };
}

async function draftsOf(user: TestUser) {
	return db.select().from(recipes).where(eq(recipes.ownerUserId, user.id));
}

async function rowsOf(recipeId: string) {
	const [ingredients, steps] = await Promise.all([
		db
			.select()
			.from(recipeIngredients)
			.where(eq(recipeIngredients.recipeId, recipeId))
			.orderBy(asc(recipeIngredients.position)),
		db
			.select()
			.from(recipeSteps)
			.where(eq(recipeSteps.recipeId, recipeId))
			.orderBy(asc(recipeSteps.position))
	]);
	return { ingredients, steps };
}

describe('import: parse action with the assistant', () => {
	it('does not call the model, start a job or save a recipe for a page the app reads itself', async () => {
		const { requests } = stubLlm([MODEL_RECIPE]);
		const out = await parse(alice, { html: JSON_LD_PAGE });
		expect(requests).toHaveLength(0);
		expect(out.source).toBe('json-ld');
		expect(out.assistantJob).toBeNull();
		expect(out.assistantError).toBeNull();
		expect(out.input.ingredients.map((i) => i.name)).toEqual(['red lentils', 'onion']);
		expect(jobsForUser(alice.id)).toEqual([]);
		expect(await draftsOf(alice)).toEqual([]);
	});

	it('starts a background job for a page with no structured recipe and saves its result as a draft', async () => {
		const { requests } = stubLlm([MODEL_RECIPE]);
		const out = await parse(alice, { html: PLAIN_PAGE });
		// The review form gets the app's own reading at once.
		expect(out.source).toBe('text');
		expect(out.assistantError).toBeNull();
		expect(out.input.title).toBe('My blog');
		expect(out.assistantJob).toMatchObject({ id: expect.any(String), title: 'My blog' });

		const job = await finished(out);
		expect(job.status).toBe('done');
		expect(job.message).toBeNull();
		expect(job.recipeId).toEqual(expect.any(String));
		expect(job.title).toBe("Grandma's pancakes");
		expect(requests).toHaveLength(1);
		expect(requests[0].messages.at(-1)!.content).toContain('Mix 200 g flour');
		expect(requests[0].messages.at(-1)!.content).not.toContain('Menu');

		const saved = await draftsOf(alice);
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			id: job.recipeId,
			status: 'draft',
			ownerUserId: alice.id,
			title: "Grandma's pancakes",
			sourceAttachmentId: out.attachmentId
		});
		const { ingredients, steps } = await rowsOf(saved[0].id);
		expect(ingredients[0]).toMatchObject({ name: 'flour', unit: 'g' });
		expect(Number(ingredients[0].amount)).toBe(200);
		expect(ingredients).toHaveLength(2);
		expect(steps.map((s) => s.text)).toEqual(['Mix and fry.']);
		// Nobody else got a recipe.
		expect(await draftsOf(bob)).toEqual([]);
	});

	it('keeps the title the user typed over the assistant’s', async () => {
		stubLlm([MODEL_RECIPE]);
		const out = await parse(alice, { html: PLAIN_PAGE, title: 'Sunday pancakes' });
		expect(out.assistantJob?.title).toBe('Sunday pancakes');
		const job = await finished(out);
		expect(job.title).toBe('Sunday pancakes');
		const [saved] = await draftsOf(alice);
		expect(saved.title).toBe('Sunday pancakes');
	});

	it('runs a job on a page the app read itself when useAssistant is on', async () => {
		const { requests } = stubLlm([
			modelReply({
				title: 'Red lentil dal',
				servings: '',
				ingredients: ['200 g red lentils', '1 onion'],
				steps: ['Simmer the lentils.', 'Fry the onion, then add it.']
			})
		]);
		const out = await parse(alice, { html: JSON_LD_PAGE, useAssistant: 'on' });
		// The form still shows the app's own reading.
		expect(out.source).toBe('json-ld');
		expect(out.input.steps[1].text).toBe('Fry the onion.');
		const job = await finished(out);
		expect(job.status).toBe('done');
		expect(requests).toHaveLength(1);
		const [saved] = await draftsOf(alice);
		expect(saved).toMatchObject({ status: 'draft', title: 'Red lentil dal' });
		const { steps } = await rowsOf(saved.id);
		expect(steps[1].text).toBe('Fry the onion, then add it.');
	});

	it('saves the app’s own reading as a draft, with a message, when the model answers with an error', async () => {
		setLlmForTests({
			config: STUB_LLM_CONFIG,
			fetch: (async () => jsonResponse({ error: { message: 'boom' } }, 500)) as typeof fetch
		});
		const out = await parse(alice, { html: PLAIN_PAGE });
		expect(out.assistantJob).not.toBeNull();
		const job = await finished(out);
		expect(job.status).toBe('done');
		expect(job.message).toEqual(expect.any(String));
		expect(job.message).not.toBe('');
		expect(job.message).not.toContain('boom');
		const [saved] = await draftsOf(alice);
		expect(saved).toMatchObject({
			id: job.recipeId,
			status: 'draft',
			title: 'My blog',
			sourceAttachmentId: out.attachmentId
		});
		expect(saved.notes).toContain('Mix 200 g flour');
		const { ingredients, steps } = await rowsOf(saved.id);
		expect(ingredients).toEqual([]);
		expect(steps).toEqual([]);
	});

	it('saves the parse of a structured page, with a message, when the forced assistant fails', async () => {
		const { requests } = stubLlm([new TypeError('fetch failed')]);
		const out = await parse(alice, { html: JSON_LD_PAGE, useAssistant: 'on' });
		const job = await finished(out);
		expect(requests).toHaveLength(1);
		expect(job.status).toBe('done');
		expect(job.message).toEqual(expect.any(String));
		expect(job.message).not.toBe('');
		const [saved] = await draftsOf(alice);
		expect(saved).toMatchObject({ status: 'draft', title: 'Red lentil dal' });
		const { ingredients } = await rowsOf(saved.id);
		expect(ingredients.map((i) => i.name)).toEqual(['red lentils', 'onion']);
	});

	it('saves the plain-text reading with a message when the model gives unreadable answers', async () => {
		stubLlm(['not json', 'still not json']);
		const out = await parse(alice, { html: PLAIN_PAGE });
		expect(out.source).toBe('text');
		expect(out.assistantError).toBeNull();
		const job = await finished(out);
		expect(job.status).toBe('done');
		expect(job.message).toEqual(expect.any(String));
		const [saved] = await draftsOf(alice);
		expect(saved).toMatchObject({ status: 'draft', title: 'My blog' });
	});

	it('imports as before, with no job and no message, when the assistant is off', async () => {
		setLlmForTests({ config: null });
		const out = await parse(alice, { html: PLAIN_PAGE, useAssistant: 'on' });
		expect(out.source).toBe('text');
		expect(out.assistantJob).toBeNull();
		expect(out.assistantError).toBeNull();
		expect(jobsForUser(alice.id)).toEqual([]);
		expect(await draftsOf(alice)).toEqual([]);
	});

	it('starts no job and shows the quota message when the user has no assistant calls left', async () => {
		const { requests } = stubLlm([MODEL_RECIPE]);
		for (let i = 0; i < LLM_LIMITS.user.max; i++) claimLlmCall(alice.id);
		const out = await parse(alice, { html: PLAIN_PAGE });
		expect(out.assistantJob).toBeNull();
		expect(out.assistantError).toMatch(/too many/i);
		// The normal result is still there to review.
		expect(out.parsed).toBe(true);
		expect(out.input.title).toBe('My blog');
		expect(requests).toHaveLength(0);
		expect(await draftsOf(alice)).toEqual([]);
	});

	it('starts no job for a user who already has the most running, and other users still can', async () => {
		const gate = gatedLlm(MODEL_RECIPE);
		const running: ParseResult[] = [];
		for (let i = 0; i < LLM_MAX_JOBS_PER_USER; i++) {
			const out = await parse(alice, { html: PLAIN_PAGE });
			expect(out.assistantJob).not.toBeNull();
			running.push(out);
		}
		const over = await parse(alice, { html: PLAIN_PAGE });
		expect(over.assistantJob).toBeNull();
		expect(over.assistantError).toEqual(expect.any(String));
		expect(over.assistantError).not.toBe('');
		expect(over.parsed).toBe(true);
		expect(jobsForUser(alice.id).filter((j) => j.status === 'running')).toHaveLength(
			LLM_MAX_JOBS_PER_USER
		);

		const others = await parse(bob, { html: PLAIN_PAGE });
		expect(others.assistantJob).not.toBeNull();

		gate.release();
		for (const out of [...running, others]) expect((await finished(out)).status).toBe('done');
		expect(await draftsOf(alice)).toHaveLength(LLM_MAX_JOBS_PER_USER);
		expect(await draftsOf(bob)).toHaveLength(1);
		// A finished job leaves room for the next one.
		stubLlm([MODEL_RECIPE]);
		const next = await parse(alice, { html: PLAIN_PAGE });
		expect(next.assistantJob).not.toBeNull();
	});
});

describe('import jobs: saving the draft', () => {
	it('links an ingredient only on an exact name, not on a reordered one', async () => {
		const chicken = await catalogIngredientId('chicken breast');
		stubLlm([
			modelReply({
				title: 'Roast chicken',
				ingredients: ['200 g chicken breast', '200 g breast chicken', '1 tbsp mystery spice'],
				steps: ['Roast.']
			})
		]);
		const out = await parse(alice, { html: PLAIN_PAGE });
		const job = await finished(out);
		expect(job.status).toBe('done');
		const { ingredients } = await rowsOf(job.recipeId!);
		expect(ingredients.map((i) => i.name)).toEqual([
			'chicken breast',
			'breast chicken',
			'mystery spice'
		]);
		expect(ingredients.map((i) => i.ingredientId)).toEqual([chicken, null, null]);
	});

	it('drops a link the caller sent for a name that is not an exact match', async () => {
		const chicken = await catalogIngredientId('chicken breast');
		stubLlm([
			modelReply({ title: 'Spice mix', ingredients: ['1 tbsp mystery spice'], steps: ['Mix.'] })
		]);
		const input = {
			...emptyRecipeFormInput(),
			title: 'Spice mix',
			ingredients: [
				{
					name: 'mystery spice',
					ingredientId: chicken,
					proposed: true,
					amount: '1',
					unit: 'tbsp',
					preparation: '',
					group: '',
					optional: false,
					createIdentity: false
				}
			],
			steps: [{ section: '', text: 'Mix.' }]
		};
		const view = await startImportJob(alice.id, {
			input,
			forced: true,
			sourceText: async () => '',
			attachmentId: null
		});
		expect(view).not.toBeNull();
		startedJobs.push(view!.id);
		const job = (await waitForJob(view!.id))!;
		expect(job.status).toBe('done');
		const { ingredients } = await rowsOf(job.recipeId!);
		expect(ingredients).toHaveLength(1);
		expect(ingredients[0].ingredientId).toBeNull();
	});

	it('refuses with a 422 before any job when the user asked for the assistant and there is no text', async () => {
		const { requests } = stubLlm([MODEL_RECIPE]);
		const args = {
			input: emptyRecipeFormInput(),
			sourceText: async () => '   ',
			attachmentId: null
		};
		await expect(startImportJob(alice.id, { ...args, forced: true })).rejects.toMatchObject({
			status: 422
		});
		// Not asked for, an empty source is just not worth a job.
		await expect(startImportJob(alice.id, { ...args, forced: false })).resolves.toBeNull();
		expect(requests).toHaveLength(0);
		expect(jobsForUser(alice.id)).toEqual([]);
	});

	it('keeps the source file of a running job out of the attachment sweep, then links it', async () => {
		const gate = gatedLlm(MODEL_RECIPE);
		const out = await parse(alice, { html: PLAIN_PAGE });
		expect(out.assistantJob).not.toBeNull();
		expect(pendingAttachmentIds()).toEqual([out.attachmentId]);

		// An age of zero minutes makes every unlinked file old enough to go.
		expect(await cleanupUnreferencedAttachments(0, pendingAttachmentIds())).toBe(0);
		const kept = await db
			.select({ id: recipeAttachments.id })
			.from(recipeAttachments)
			.where(eq(recipeAttachments.id, out.attachmentId));
		expect(kept).toHaveLength(1);

		gate.release();
		const job = await finished(out);
		expect(job.status).toBe('done');
		expect(pendingAttachmentIds()).toEqual([]);
		const [saved] = await draftsOf(alice);
		expect(saved.sourceAttachmentId).toBe(out.attachmentId);
	});
});

describe('import jobs: list and dismiss', () => {
	it('lists only the caller’s jobs', async () => {
		const gate = gatedLlm(MODEL_RECIPE);
		const mine = await parse(alice, { html: PLAIN_PAGE });
		const theirs = await parse(bob, { html: PLAIN_PAGE });

		const aliceList = await listAssistantJobs(requestAs(alice));
		expect(aliceList.jobs.map((j) => j.id)).toEqual([mine.assistantJob!.id]);
		expect(aliceList.jobs[0]).toMatchObject({ status: 'running', recipeId: null });
		const bobList = await listAssistantJobs(requestAs(bob));
		expect(bobList.jobs.map((j) => j.id)).toEqual([theirs.assistantJob!.id]);

		gate.release();
		await finished(mine);
		await finished(theirs);
		const done = await listAssistantJobs(requestAs(alice));
		expect(done.jobs).toHaveLength(1);
		expect(done.jobs[0]).toMatchObject({ status: 'done', recipeId: expect.any(String) });
	});

	it('is a 401 for a signed-out caller', async () => {
		await expect(listAssistantJobs(requestAs(null))).rejects.toMatchObject({ status: 401 });
		await expect(dismissAssistantJobFor(requestAs(null), { id: 'x' })).rejects.toMatchObject({
			status: 401
		});
	});

	it('refuses to dismiss a running job, ignores another user’s job, and removes a finished one', async () => {
		const gate = gatedLlm(MODEL_RECIPE);
		const out = await parse(alice, { html: PLAIN_PAGE });
		const id = out.assistantJob!.id;

		await expect(dismissAssistantJobFor(requestAs(alice), { id })).rejects.toMatchObject({
			status: 409
		});
		// Another user's job and an unknown id are ignored, running or not.
		const byBob = await dismissAssistantJobFor(requestAs(bob), { id });
		expect(byBob.jobs).toEqual([]);
		const unknown = await dismissAssistantJobFor(requestAs(alice), {
			id: '00000000-0000-4000-8000-000000000000'
		});
		expect(unknown.jobs.map((j) => j.id)).toEqual([id]);

		gate.release();
		await finished(out);
		// Still not Bob's to dismiss once it is finished.
		await dismissAssistantJobFor(requestAs(bob), { id });
		expect(jobsForUser(alice.id).map((j) => j.id)).toEqual([id]);

		const after = await dismissAssistantJobFor(requestAs(alice), { id });
		expect(after.jobs).toEqual([]);
		expect(jobsForUser(alice.id)).toEqual([]);
		expect(waitForJob(id)).toBeUndefined();
		// The recipe the job saved stays.
		expect(await draftsOf(alice)).toHaveLength(1);
	});
});

/* Grocery tidy and ingredient match suggestions. */

const MESSY_LINE = '2x tins chopped tomatoes 400g';

const tidyReply = (
	lines: { id: number; name: string; amount: string; unit: string; aisle: string }[]
) => JSON.stringify({ lines });

/** A draft list of `user`'s household with the given manual lines (all unlinked, no amount unless given). */
async function listWith(
	user: TestUser,
	lines: { name: string; amount?: string; category?: string }[]
): Promise<{ listId: string; lineIds: string[] }> {
	const listId = await createList(user.ctx, 'Weekly');
	const lineIds: string[] = [];
	for (const l of lines) {
		const { lineId } = await addManualLine(user.ctx, {
			listId,
			name: l.name,
			ingredientId: null,
			amount: l.amount ? d(l.amount) : null,
			unit: null,
			category: l.category ?? '',
			subtractPantry: false,
			note: ''
		});
		lineIds.push(lineId);
	}
	return { listId, lineIds };
}

const detailOf = (user: TestUser, listId: string) => getListDetail(db, user.householdId, listId);

/** A form-action event for the grocery list page. */
function groceryEvent(
	user: TestUser,
	listId: string,
	action: string,
	fields: Record<string, string>
): RequestEvent {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return {
		...requestAs(user),
		params: { listId },
		request: new Request(`http://localhost/grocery/${listId}?/${action}`, { method: 'POST', body })
	} as unknown as RequestEvent;
}

interface ActionResult {
	ok?: boolean;
	applied?: number;
	conflicts?: string[];
	message?: string;
}

/** What a SvelteKit action returned: its data, or the data of `fail(...)` with its status. */
async function runAction(
	name: 'addLine' | 'applyTidy',
	event: RequestEvent
): Promise<{ status: number; data: ActionResult }> {
	const out = (await groceryActions[name]!(event as never)) as unknown as
		ActionResult | { status: number; data: ActionResult };
	return 'status' in out ? out : { status: 200, data: out };
}

describe('grocery tidy', () => {
	it('proposes changes from the reply and writes nothing', async () => {
		const { listId, lineIds } = await listWith(alice, [{ name: MESSY_LINE }]);
		const { requests } = stubLlm([
			tidyReply([{ id: 1, name: 'chopped tomatoes', amount: '400', unit: 'g', aisle: 'Pantry' }])
		]);
		const before = await detailOf(alice, listId);

		const out = await tidyGroceryList(requestAs(alice), { listId });

		expect(requests).toHaveLength(1);
		expect(requests[0].messages.at(-1)!.content).toContain(`1: ${MESSY_LINE}`);
		expect(out.sent).toBe(1);
		expect(out.proposals).toHaveLength(1);
		expect(out.proposals[0]).toMatchObject({
			lineId: lineIds[0],
			revision: before.lines[0].revision,
			kind: 'manual',
			before: { name: MESSY_LINE, amount: null, unit: null, category: 'Other' },
			after: { name: 'chopped tomatoes', amount: '400', unit: 'g', category: 'Pantry' }
		});
		expect(out.proposals[0].changed.sort()).toEqual(['amount', 'category', 'name', 'unit']);
		// Only Apply changes rows.
		expect(await detailOf(alice, listId)).toEqual(before);
	});

	it('drops an amount the model made up, and keeps the name and aisle it gave', async () => {
		const { listId } = await listWith(alice, [{ name: MESSY_LINE }]);
		stubLlm([
			tidyReply([{ id: 1, name: 'chopped tomatoes', amount: '800', unit: 'g', aisle: 'Pantry' }])
		]);
		const out = await tidyGroceryList(requestAs(alice), { listId });
		expect(out.proposals).toHaveLength(1);
		expect(out.proposals[0].after).toEqual({
			name: 'chopped tomatoes',
			amount: null,
			unit: null,
			category: 'Pantry'
		});
		expect(out.proposals[0].changed.sort()).toEqual(['category', 'name']);
	});

	it('proposes nothing for an id it did not send or an aisle that is not on the list', async () => {
		const { listId } = await listWith(alice, [{ name: MESSY_LINE }]);
		stubLlm([
			tidyReply([
				{ id: 7, name: 'ghost', amount: '', unit: '', aisle: 'Pantry' },
				{ id: 1, name: MESSY_LINE, amount: '', unit: '', aisle: 'Other' }
			])
		]);
		const out = await tidyGroceryList(requestAs(alice), { listId });
		expect(out.sent).toBe(1);
		expect(out.proposals).toEqual([]);
	});

	it('applies the kept proposals through the applyTidy action, bumping the revisions', async () => {
		const { listId, lineIds } = await listWith(alice, [{ name: MESSY_LINE }, { name: 'bananas' }]);
		stubLlm([
			tidyReply([
				{ id: 1, name: 'chopped tomatoes', amount: '400', unit: 'g', aisle: 'Pantry' },
				{ id: 2, name: 'bananas', amount: '', unit: '', aisle: 'Produce' }
			])
		]);
		const before = await detailOf(alice, listId);
		const { proposals } = await tidyGroceryList(requestAs(alice), { listId });
		expect(proposals).toHaveLength(2);

		const fields: Record<string, string> = {};
		proposals.forEach((p, i) => {
			fields[`change.${i}.lineId`] = p.lineId;
			fields[`change.${i}.expectedRevision`] = String(p.revision);
			if (p.changed.includes('name')) fields[`change.${i}.name`] = p.after.name;
			if (p.changed.includes('amount')) {
				fields[`change.${i}.amount`] = p.after.amount ?? '';
				fields[`change.${i}.unit`] = p.after.unit ?? '';
			}
			if (p.changed.includes('category')) fields[`change.${i}.category`] = p.after.category;
		});
		const res = await runAction('applyTidy', groceryEvent(alice, listId, 'applyTidy', fields));
		expect(res.status).toBe(200);
		expect(res.data).toMatchObject({ ok: true, applied: 2 });

		const after = await detailOf(alice, listId);
		const tomatoes = after.lines.find((l) => l.id === lineIds[0])!;
		expect(tomatoes).toMatchObject({ name: 'chopped tomatoes', unit: 'g', category: 'Pantry' });
		expect(Number(tomatoes.demandAmount)).toBe(400);
		expect(tomatoes.revision).toBe(before.lines.find((l) => l.id === lineIds[0])!.revision + 1);
		expect(after.lines.find((l) => l.id === lineIds[1])).toMatchObject({
			name: 'bananas',
			category: 'Produce'
		});
		expect(after.revision).toBeGreaterThan(before.revision);
	});

	it('gives a conflict for a line changed after the proposal, and still applies the others', async () => {
		const { listId, lineIds } = await listWith(alice, [{ name: MESSY_LINE }, { name: 'bananas' }]);
		stubLlm([
			tidyReply([
				{ id: 1, name: 'chopped tomatoes', amount: '', unit: '', aisle: 'Pantry' },
				{ id: 2, name: 'bananas', amount: '', unit: '', aisle: 'Produce' }
			])
		]);
		const { proposals } = await tidyGroceryList(requestAs(alice), { listId });
		expect(proposals).toHaveLength(2);

		// Someone edits the first line while the review sheet is open.
		await updateLine(alice.ctx, {
			listId,
			lineId: lineIds[0],
			expectedRevision: proposals[0].revision,
			note: 'the small tins'
		});
		await expect(
			updateLine(alice.ctx, {
				listId,
				lineId: lineIds[0],
				expectedRevision: proposals[0].revision,
				name: 'chopped tomatoes'
			})
		).rejects.toBeInstanceOf(ReviewConflict);

		const fields: Record<string, string> = {};
		proposals.forEach((p, i) => {
			fields[`change.${i}.lineId`] = p.lineId;
			fields[`change.${i}.expectedRevision`] = String(p.revision);
			fields[`change.${i}.category`] = p.after.category;
		});
		const res = await runAction('applyTidy', groceryEvent(alice, listId, 'applyTidy', fields));
		expect(res.status).toBe(409);
		expect(res.data).toMatchObject({ applied: 1, conflicts: [lineIds[0]] });

		const after = await detailOf(alice, listId);
		expect(after.lines.find((l) => l.id === lineIds[0])).toMatchObject({
			name: MESSY_LINE,
			category: 'Other',
			note: 'the small tins'
		});
		expect(after.lines.find((l) => l.id === lineIds[1])!.category).toBe('Produce');
	});

	it('is a 400 for an applyTidy post with no changes, an unknown aisle or a bad line id', async () => {
		const { listId, lineIds } = await listWith(alice, [{ name: MESSY_LINE }]);
		const before = await detailOf(alice, listId);
		const base = { 'change.0.lineId': lineIds[0], 'change.0.expectedRevision': '0' };
		const posts: Record<string, string>[] = [
			{},
			{ ...base, 'change.0.category': 'Gadgets' },
			{ 'change.0.lineId': 'not-a-uuid', 'change.0.expectedRevision': '0' }
		];
		for (const fields of posts) {
			const res = await runAction('applyTidy', groceryEvent(alice, listId, 'applyTidy', fields));
			expect(res.status).toBe(400);
		}
		expect(await detailOf(alice, listId)).toEqual(before);
	});

	it('is a 404 for another household’s list, with no model call and no quota spent', async () => {
		const { listId } = await listWith(bob, [{ name: MESSY_LINE }]);
		const { requests } = stubLlm([tidyReply([])]);
		await expect(tidyGroceryList(requestAs(alice), { listId })).rejects.toMatchObject({
			status: 404
		});
		await expect(tidyGroceryList(requestAs(alice), { listId: 'nope' })).rejects.toMatchObject({
			status: 404
		});
		expect(requests).toHaveLength(0);
		// Every call in Alice's allowance is still there.
		for (let i = 0; i < LLM_LIMITS.user.max; i++) claimLlmCall(alice.id);
		expect(() => claimLlmCall(alice.id)).toThrow(expect.objectContaining({ status: 429 }));
	});

	it('returns sent: 0 with no model call or quota when no line needs help', async () => {
		const { listId } = await listWith(alice, [
			{ name: 'bananas', amount: '6', category: 'Produce' }
		]);
		const { requests } = stubLlm([tidyReply([])]);
		const out = await tidyGroceryList(requestAs(alice), { listId });
		expect(out).toEqual({ proposals: [], sent: 0 });
		const empty = await createList(alice.ctx, 'Empty');
		expect(await tidyGroceryList(requestAs(alice), { listId: empty })).toEqual({
			proposals: [],
			sent: 0
		});
		expect(requests).toHaveLength(0);
		for (let i = 0; i < LLM_LIMITS.user.max; i++) claimLlmCall(alice.id);
	});

	it('is a 429 when the allowance is used up, and a 401 when signed out, with no model call', async () => {
		const { listId } = await listWith(alice, [{ name: MESSY_LINE }]);
		const { requests } = stubLlm([tidyReply([])]);
		await expect(tidyGroceryList(requestAs(null), { listId })).rejects.toMatchObject({
			status: 401
		});
		for (let i = 0; i < LLM_LIMITS.user.max; i++) claimLlmCall(alice.id);
		await expect(tidyGroceryList(requestAs(alice), { listId })).rejects.toMatchObject({
			status: 429
		});
		expect(requests).toHaveLength(0);
	});

	it('is a 503 when the assistant is off', async () => {
		const { listId } = await listWith(alice, [{ name: MESSY_LINE }]);
		setLlmForTests({ config: null });
		await expect(tidyGroceryList(requestAs(alice), { listId })).rejects.toMatchObject({
			status: 503
		});
	});
});

describe('updateLine: name, unit and link', () => {
	it('changes the name, unit and catalog link of a manual line', async () => {
		const chicken = await catalogIngredientId('chicken breast');
		const { listId, lineIds } = await listWith(alice, [{ name: 'chiken 500g' }]);
		const line = (await detailOf(alice, listId)).lines[0];
		await updateLine(alice.ctx, {
			listId,
			lineId: lineIds[0],
			expectedRevision: line.revision,
			name: '  chicken   breast ',
			unit: 'g',
			ingredientId: chicken,
			amount: d(500)
		});
		const changed = (await detailOf(alice, listId)).lines[0];
		expect(changed).toMatchObject({
			name: 'chicken breast',
			unit: 'g',
			ingredientId: chicken,
			revision: line.revision + 1
		});
		expect(Number(changed.demandAmount)).toBe(500);

		await updateLine(alice.ctx, {
			listId,
			lineId: lineIds[0],
			expectedRevision: changed.revision,
			unit: null,
			ingredientId: null
		});
		expect((await detailOf(alice, listId)).lines[0]).toMatchObject({
			unit: null,
			ingredientId: null
		});
	});

	it('is a 400 for a blank name or an unknown unit, and leaves the line as it was', async () => {
		const { listId, lineIds } = await listWith(alice, [{ name: 'rice' }]);
		const before = await detailOf(alice, listId);
		const base = { listId, lineId: lineIds[0], expectedRevision: before.lines[0].revision };
		await expect(updateLine(alice.ctx, { ...base, name: '   ' })).rejects.toMatchObject({
			status: 400
		});
		await expect(updateLine(alice.ctx, { ...base, unit: 'bushels' })).rejects.toMatchObject({
			status: 400
		});
		expect(await detailOf(alice, listId)).toEqual(before);
	});

	it('is a 409 for a name, unit or link on a recipe line', async () => {
		const chicken = await catalogIngredientId('chicken breast');
		const recipeId = await makeChickenRecipe(alice, 'Roast', '500');
		const listId = await createList(alice.ctx, 'Recipes');
		await addBatch(alice.ctx, {
			listId,
			recipeId,
			servings: d(4),
			clientKey: 'tidy',
			includeOptional: []
		});
		const before = await detailOf(alice, listId);
		const line = before.lines.find((l) => l.kind === 'recipe')!;
		const base = { listId, lineId: line.id, expectedRevision: line.revision };
		for (const edit of [{ name: 'hen' }, { unit: 'kg' }, { ingredientId: chicken }]) {
			const err = await updateLine(alice.ctx, { ...base, ...edit }).catch((e) => e);
			expect(err).toBeInstanceOf(AppError);
			expect(err).not.toBeInstanceOf(ReviewConflict);
			expect(err.status).toBe(409);
		}
		// Its aisle can still change.
		await updateLine(alice.ctx, { ...base, category: 'Meat & fish' });
		const after = await detailOf(alice, listId);
		expect(after.lines.find((l) => l.id === line.id)).toMatchObject({
			name: line.name,
			unit: line.unit,
			ingredientId: line.ingredientId,
			category: 'Meat & fish'
		});
	});
});

describe('grocery addLine action', () => {
	const added = async (fields: Record<string, string>) => {
		const { listId } = await listWith(alice, []);
		const res = await runAction('addLine', groceryEvent(alice, listId, 'addLine', fields));
		expect(res.status).toBe(200);
		const lines = (await detailOf(alice, listId)).lines;
		expect(lines).toHaveLength(1);
		return lines[0];
	};

	it('splits "400 g rice" typed in the name alone into amount, unit and name', async () => {
		const line = await added({ name: '400 g rice' });
		expect(line).toMatchObject({ name: 'rice', unit: 'g', kind: 'manual' });
		expect(Number(line.demandAmount)).toBe(400);
	});

	it('keeps a line it cannot read exactly as typed', async () => {
		for (const name of [MESSY_LINE, 'bananas']) {
			const line = await added({ name });
			expect(line).toMatchObject({ name, unit: null, demandAmount: null });
		}
	});

	it('does not split when the amount or unit field is filled in', async () => {
		const withAmount = await added({ name: '400 g rice', amount: '2' });
		expect(withAmount).toMatchObject({ name: '400 g rice', unit: null });
		expect(Number(withAmount.demandAmount)).toBe(2);
	});
});

describe('suggestIngredientMatch', () => {
	const pickReply = (picks: { name: string; pick: number | null }[]) => JSON.stringify({ picks });

	/** Rows the suggestion must never touch. */
	const catalogState = async () => ({
		ingredients: await db.select().from(ingredientRows),
		recipeIngredients: await db.select().from(recipeIngredients)
	});

	it('maps a pick to that candidate, asks with numbered candidates, and writes nothing', async () => {
		const candidates = await searchIngredients(db, alice.id, 'chicken', 5, alice.householdId);
		expect(candidates.length).toBeGreaterThan(1);
		const { requests } = stubLlm([pickReply([{ name: 'chicken', pick: 2 }])]);
		const before = await catalogState();

		const out = await suggestIngredientMatch(requestAs(alice), { names: ['chicken'] });

		expect(out.picks).toEqual({ chicken: candidates[1] });
		expect(requests).toHaveLength(1);
		expect(requests[0].response_format?.type).toBe('json_schema');
		const asked = requests[0].messages.at(-1)!.content;
		expect(asked).toContain('1. chicken');
		candidates.forEach((c, i) => expect(asked).toContain(`${i + 1}) ${c.name}`));
		expect(await catalogState()).toEqual(before);
	});

	it('gives null for a null pick and for a pick outside the candidates', async () => {
		stubLlm([
			pickReply([
				{ name: 'chicken', pick: 99 },
				{ name: 'milk', pick: null },
				{ name: 'rice', pick: 0 }
			])
		]);
		const out = await suggestIngredientMatch(requestAs(alice), {
			names: ['chicken', 'milk', 'rice']
		});
		expect(out.picks).toEqual({ chicken: null, milk: null, rice: null });
	});

	it('makes no model call and spends no quota for names with no candidates', async () => {
		const gibberish = 'qqzzxxvvkk';
		expect(await searchIngredients(db, alice.id, gibberish, 5, alice.householdId)).toEqual([]);
		const { requests } = stubLlm([pickReply([])]);
		const out = await suggestIngredientMatch(requestAs(alice), { names: [gibberish, '   '] });
		expect(out.picks).toEqual({ [gibberish]: null });
		expect(requests).toHaveLength(0);
		for (let i = 0; i < LLM_LIMITS.user.max; i++) claimLlmCall(alice.id);
	});

	it('asks only about names that have candidates, and answers null for the rest', async () => {
		const gibberish = 'qqzzxxvvkk';
		const candidates = await searchIngredients(db, alice.id, 'chicken', 5, alice.householdId);
		const { requests } = stubLlm([pickReply([{ name: 'chicken', pick: 1 }])]);
		const out = await suggestIngredientMatch(requestAs(alice), { names: [gibberish, 'chicken'] });
		expect(out.picks).toEqual({ [gibberish]: null, chicken: candidates[0] });
		expect(requests[0].messages.at(-1)!.content).not.toContain(gibberish);
	});

	it('is a 401 signed out and a 429 when the allowance is used up, with no model call', async () => {
		const { requests } = stubLlm([pickReply([{ name: 'chicken', pick: 1 }])]);
		await expect(
			suggestIngredientMatch(requestAs(null), { names: ['chicken'] })
		).rejects.toMatchObject({ status: 401 });
		for (let i = 0; i < LLM_LIMITS.user.max; i++) claimLlmCall(alice.id);
		await expect(
			suggestIngredientMatch(requestAs(alice), { names: ['chicken'] })
		).rejects.toMatchObject({ status: 429 });
		expect(requests).toHaveLength(0);
	});

	it('is a 503 when the assistant is off', async () => {
		setLlmForTests({ config: null });
		await expect(
			suggestIngredientMatch(requestAs(alice), { names: ['chicken'] })
		).rejects.toMatchObject({ status: 503 });
	});
});

describe('recipe edit: aiFix action', () => {
	it('does not reach the model when the browser has already gone away', async () => {
		const { requests } = stubLlm([MODEL_RECIPE]);
		const recipeId = await createRecipe(
			alice.id,
			recipeInput({ title: 'Pancakes', ingredients: [] })
		);
		const body = new FormData();
		body.set('title', 'Pancakes');
		body.set('steps.0.text', 'Mix and fry.');
		const event = {
			...requestAs(alice),
			params: { id: recipeId },
			request: new Request(`http://localhost/recipes/${recipeId}/edit?/aiFix`, {
				method: 'POST',
				body,
				signal: AbortSignal.abort()
			})
		} as unknown as RequestEvent;
		const out = (await editActions.aiFix!(event as never)) as unknown as { status: number };
		expect(out.status).toBe(499);
		expect(requests).toHaveLength(0);
	});
});
