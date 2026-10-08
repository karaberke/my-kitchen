import { requireUser } from '$lib/server/access';
import { guard } from '$lib/server/http';
import { llmEnabled } from '$lib/server/llm/client';
import { jobsForUser } from '$lib/server/llm/jobs';
import type { LayoutServerLoadEvent } from './$types';

/** Layout guard for the signed-in area. Every page and action re-checks permissions itself. */
const loadImpl = (event: LayoutServerLoadEvent) => {
	const user = requireUser(event);
	// In memory, so cheap: the job list renders without a first request.
	return { assistantJobs: llmEnabled() ? jobsForUser(user.id) : [] };
};

export const load = guard(loadImpl);
