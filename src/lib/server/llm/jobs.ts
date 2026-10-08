import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { AppError } from '$lib/server/errors';
import { resolveIngredientNames } from '$lib/server/ingredient-match';
import { attachToRecipe } from '$lib/server/media/attachments';
import { saveRecipeInput } from '$lib/server/recipe-form';
import type { RecipeFormInput } from '$lib/shared/recipe-input';
import { claimLlmCall } from './client';
import {
	assistWanted,
	planAssist,
	runAssist,
	type AssistPlan,
	type ImportAssistArgs
} from './recipe';

/**
 * Assistant work nobody waits on: an import the model reads in the background
 * and then saves as a draft.
 *
 * Jobs live in this process only, like the rate-limit buckets. A restart loses
 * the running ones and the list; the source attachment then goes the way of
 * any abandoned import.
 */

/** A finished job stays in the list this long unless the user dismisses it first. */
export const LLM_JOB_KEEP_MS = 60 * 60 * 1000;
/** Imports one user may have running at the same time. */
export const LLM_MAX_JOBS_PER_USER = 3;

export type AssistantJobStatus = 'running' | 'done' | 'failed';

/** A job as the client sees it. `message` is safe to show; dates are ISO strings. */
export interface AssistantJobView {
	id: string;
	title: string;
	status: AssistantJobStatus;
	startedAt: string;
	finishedAt: string | null;
	recipeId: string | null;
	message: string | null;
}

interface AssistantJob {
	id: string;
	userId: string;
	title: string;
	status: AssistantJobStatus;
	startedAt: Date;
	finishedAt: Date | null;
	recipeId: string | null;
	message: string | null;
	attachmentId: string | null;
	done: Promise<void>;
}

const jobs = new Map<string, AssistantJob>();

const FALLBACK_SAVED =
	"The assistant's version could not be saved, so the recipe was saved as the app read it.";
const DRAFT_NOT_SAVED = 'The recipe could not be saved as a draft.';

function view(job: AssistantJob): AssistantJobView {
	return {
		id: job.id,
		title: job.title,
		status: job.status,
		startedAt: job.startedAt.toISOString(),
		finishedAt: job.finishedAt?.toISOString() ?? null,
		recipeId: job.recipeId,
		message: job.message
	};
}

/** Drop finished jobs older than `LLM_JOB_KEEP_MS`. Returns how many went. */
export function pruneAssistantJobs(now = Date.now()): number {
	let removed = 0;
	for (const [id, job] of jobs) {
		if (job.finishedAt && now - job.finishedAt.getTime() > LLM_JOB_KEEP_MS) {
			jobs.delete(id);
			removed++;
		}
	}
	return removed;
}

/** Running jobs, then finished ones not yet dismissed or expired, newest first. */
export function jobsForUser(userId: string): AssistantJobView[] {
	pruneAssistantJobs();
	return [...jobs.values()]
		.filter((j) => j.userId === userId)
		.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
		.map(view);
}

/**
 * Remove a finished job from the user's list. A job that is not the user's,
 * or is already gone, is ignored; a running one is a 409.
 */
export function dismissJob(userId: string, jobId: string): void {
	const job = jobs.get(jobId);
	if (!job || job.userId !== userId) return;
	if (job.status === 'running')
		throw new AppError(409, 'The assistant is still working on this recipe.');
	jobs.delete(jobId);
}

/** Source files a running job will link when it saves; the attachment sweep keeps them. */
export function pendingAttachmentIds(): string[] {
	return [...jobs.values()]
		.filter((j) => j.status === 'running' && j.attachmentId)
		.map((j) => j.attachmentId!);
}

/** Test hook: resolves when the job has finished (it never rejects); undefined for an unknown id. */
export function waitForJob(jobId: string): Promise<AssistantJobView> | undefined {
	const job = jobs.get(jobId);
	return job?.done.then(() => view(job));
}

/** Test hook: forget every job. Work still running finishes, but is not listed. */
export function resetAssistantJobs() {
	jobs.clear();
}

function runningFor(userId: string): number {
	let n = 0;
	for (const j of jobs.values()) if (j.userId === userId && j.status === 'running') n++;
	return n;
}

function assertJobRoom(userId: string) {
	if (runningFor(userId) >= LLM_MAX_JOBS_PER_USER)
		throw new AppError(
			429,
			`The assistant is already reading ${LLM_MAX_JOBS_PER_USER} recipes for you. Wait for one to finish.`
		);
}

/**
 * `input` as a draft. An import's links are proposals the user confirms by
 * saving; nobody confirms a background save, so only a strict match (exact
 * name or curated alias, one identity) is linked, and every other row stays
 * unlinked for the user to settle when they open the draft.
 */
async function asDraft(userId: string, input: RecipeFormInput): Promise<RecipeFormInput> {
	const hits = await resolveIngredientNames(
		db,
		userId,
		input.ingredients.map((i) => i.name).filter((n) => n.trim())
	);
	return {
		...input,
		intent: 'draft',
		expectedRevision: null,
		removeImage: false,
		ingredients: input.ingredients.map((i) => ({
			...i,
			ingredientId: hits.get(i.name)?.ingredientId ?? null,
			proposed: false,
			createIdentity: false
		}))
	};
}

/** Save `input` as a new draft and link the source file, the way the import save does. */
async function saveDraft(
	userId: string,
	input: RecipeFormInput,
	attachmentId: string | null
): Promise<{ ok: true; recipeId: string } | { ok: false; message: string }> {
	const draft = await asDraft(userId, input);
	let saved = await saveRecipeInput(userId, draft, null, null);
	// A picture that cannot be fetched must not cost the recipe.
	if (!saved.ok && saved.data.errors.image && draft.imageUrl)
		saved = await saveRecipeInput(userId, { ...draft, imageUrl: '' }, null, null);
	if (!saved.ok)
		return { ok: false, message: saved.status === 400 ? DRAFT_NOT_SAVED : saved.data.message };
	if (attachmentId) await attachToRecipe(db, userId, saved.recipeId, attachmentId);
	return saved;
}

async function runImportJob(job: AssistantJob, plan: AssistPlan, titleOverride: string) {
	const titled = (input: RecipeFormInput) =>
		titleOverride ? { ...input, title: titleOverride } : input;
	try {
		const assist = await runAssist(plan, { background: true });
		let input = titled(assist.input);
		let message = assist.assistantError;
		let saved = await saveDraft(job.userId, input, job.attachmentId);
		if (!saved.ok && assist.assisted) {
			// Nothing is lost: the app's own reading is saved instead.
			input = titled(plan.base);
			saved = await saveDraft(job.userId, input, job.attachmentId);
			if (saved.ok) message = FALLBACK_SAVED;
		}
		if (saved.ok) {
			job.status = 'done';
			job.recipeId = saved.recipeId;
			job.title = input.title.trim() || job.title;
			job.message = message;
		} else {
			job.status = 'failed';
			job.message = saved.message;
		}
	} catch (err) {
		console.warn('llm: import job failed', err instanceof Error ? err.name : typeof err);
		job.status = 'failed';
		job.message = DRAFT_NOT_SAVED;
	}
	job.finishedAt = new Date();
}

/**
 * Start the assistant on an import, in the background, and return the job at
 * once; null when the assistant has nothing to do (see `assistWanted`), in
 * which case the import goes on as usual.
 *
 * Everything that can refuse the job happens before it starts and throws an
 * `AppError`: too many running jobs (429), the quota (429), the assistant
 * off (503), or nothing to read when the user asked for it (422). When the
 * job ends, the recipe is a draft of this user's, linked to `attachmentId`.
 */
export async function startImportJob(
	userId: string,
	args: ImportAssistArgs & {
		attachmentId: string | null;
		/** the title the user typed, kept over the assistant's */
		titleOverride?: string;
		/** shown while the job runs when the parse found no title, such as a file name */
		label?: string;
	}
): Promise<AssistantJobView | null> {
	// The caller keeps changing its copy (link proposals); the job reads its own.
	const input = structuredClone(args.input);
	if (!assistWanted(input, args.forced)) return null;
	assertJobRoom(userId);
	let planned: Awaited<ReturnType<typeof planAssist>>;
	try {
		planned = await planAssist({ input, forced: args.forced, sourceText: args.sourceText });
	} catch (err) {
		if (err instanceof AppError) throw err;
		console.warn('llm: import source unreadable', err instanceof Error ? err.name : typeof err);
		throw new AppError(422, 'The assistant could not read this recipe.');
	}
	if ('skip' in planned) {
		if (planned.skip) throw new AppError(422, planned.skip);
		return null;
	}
	// Checked again: reading the source gave other requests a turn.
	assertJobRoom(userId);
	claimLlmCall(userId);
	const titleOverride = args.titleOverride?.trim() ?? '';
	const job: AssistantJob = {
		id: randomUUID(),
		userId,
		title: titleOverride || input.title.trim() || args.label?.trim() || 'Imported recipe',
		status: 'running',
		startedAt: new Date(),
		finishedAt: null,
		recipeId: null,
		message: null,
		attachmentId: args.attachmentId,
		done: Promise.resolve()
	};
	jobs.set(job.id, job);
	// Not awaited, and it never rejects: runImportJob catches everything.
	job.done = runImportJob(job, planned.plan, titleOverride);
	return view(job);
}

/** The signed-in user's jobs; the remote `assistantJobs` query. */
export async function listAssistantJobs(
	event: RequestEvent
): Promise<{ jobs: AssistantJobView[] }> {
	const user = requireUserApi(event);
	return { jobs: jobsForUser(user.id) };
}

/** Dismiss one finished job of the signed-in user; the remote `dismissAssistantJob` command. */
export async function dismissAssistantJobFor(
	event: RequestEvent,
	arg: { id: string }
): Promise<{ jobs: AssistantJobView[] }> {
	const user = requireUserApi(event);
	dismissJob(user.id, arg.id);
	return { jobs: jobsForUser(user.id) };
}
