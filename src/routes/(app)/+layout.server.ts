import { requireUser } from '$lib/server/access';
import type { LayoutServerLoad } from './$types';

/** Layout guard for the signed-in area. Every page and action re-checks permissions itself. */
export const load: LayoutServerLoad = (event) => {
	requireUser(event);
	return {};
};
