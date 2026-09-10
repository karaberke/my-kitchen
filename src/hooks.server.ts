import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { randomUUID } from 'node:crypto';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { listMemberships } from '$lib/server/households';
import { resolveActiveHousehold } from '$lib/server/access';
import { applyResponsePolicy } from '$lib/server/http';
import { ensureAdminAccount } from '$lib/server/bootstrap';
import { cleanupUnreferencedImages } from '$lib/server/media/images';
import { cleanupUnreferencedAttachments } from '$lib/server/media/attachments';
import { cleanupOperations } from '$lib/server/operations';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Housekeeping the app has no other trigger for.
 *
 * An import stores its source file during the *parse* step, before the user has
 * decided to keep anything, and a replaced photo outlives the recipe that
 * referenced it — so both leak on every abandoned edit. Idempotency records
 * accumulate the same way. All three sweeps only ever touch rows nothing
 * references; a referenced image or attachment is never a candidate.
 */
async function sweep(): Promise<void> {
	for (const [what, run] of [
		['images', cleanupUnreferencedImages],
		['attachments', cleanupUnreferencedAttachments],
		['operations', cleanupOperations]
	] as const) {
		try {
			const n = await run();
			if (n > 0) console.log(`sweep: removed ${n} unreferenced ${what}`);
		} catch (err) {
			console.error(`sweep: ${what} failed`, err);
		}
	}
}

/** Runs once when the server starts: creates the ADMIN_* account if it does not exist yet. */
export const init: ServerInit = async () => {
	if (building) return;
	await ensureAdminAccount();
	// Not awaited: start-up must not wait on housekeeping. unref() keeps the
	// timer from holding the process open during a shutdown.
	void sweep();
	setInterval(() => void sweep(), SWEEP_INTERVAL_MS).unref();
};

/**
 * Resolve the session exactly once per request into request-scoped locals.
 * No module-level user/household state exists anywhere on the server.
 */
const handleSession: Handle = async ({ event, resolve }) => {
	event.locals.requestId = randomUUID();
	event.locals.user = null;
	event.locals.session = null;
	event.locals.memberships = [];
	event.locals.household = null;

	// Accounts are only ever created through the app's own /register action (which applies the
	// registration policy) or the ADMIN_* bootstrap, never through Better Auth's raw endpoint.
	if (event.url.pathname.startsWith('/api/auth/sign-up')) {
		return applyResponsePolicy(event, new Response('Not found', { status: 404 }));
	}

	if (!building) {
		const result = await auth.api.getSession({ headers: event.request.headers });
		if (result) {
			event.locals.session = result.session;
			event.locals.user = result.user;
			event.locals.memberships = await listMemberships(db, result.user.id);
			event.locals.household = await resolveActiveHousehold(
				db,
				result.user.id,
				event.locals.memberships
			);
		}
	}

	const response = await svelteKitHandler({ event, resolve, auth, building });
	return applyResponsePolicy(event, response);
};

export const handle: Handle = handleSession;

export const handleError: HandleServerError = ({ error, event }) => {
	const id = event.locals?.requestId ?? 'unknown';
	console.error(`[${id}] ${event.request.method} ${event.url.pathname}`, error);
	return { message: 'Something went wrong on our side. Please try again.', code: id };
};
