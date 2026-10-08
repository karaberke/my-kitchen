import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import {
	catalogIngredientId,
	createUser,
	makeChickenRecipe,
	requestAs,
	resetDb,
	type TestUser
} from './helpers';
import { db } from '$lib/server/db';
import { recipeAttachments, recipeIngredients, recipes, recipeSteps } from '$lib/server/db/schema';
import { AppError } from '$lib/server/errors';
import { askAboutRecipe } from '$lib/server/llm/ask';
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
import { cleanupUnreferencedAttachments } from '$lib/server/media/attachments';
import { LLM_LIMITS, resetRateLimits } from '$lib/server/ratelimit';
import { emptyRecipeFormInput } from '$lib/shared/recipe-html';
import { LLM_QUESTION_MAX_CHARS } from '$lib/shared/recipe-input';
import { actions } from '../../src/routes/(app)/recipes/import/+page.server';
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
