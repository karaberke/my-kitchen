import { requireUser } from '$lib/server/access';
import { guard } from '$lib/server/http';
import type { LayoutServerLoadEvent } from './$types';

/** Layout guard for the signed-in area. Every page and action re-checks permissions itself. */
const loadImpl = (event: LayoutServerLoadEvent) => {
	requireUser(event);
	return {};
};

export const load = guard(loadImpl);
