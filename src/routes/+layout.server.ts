import type { LayoutServerLoad } from './$types';
import { env } from '$env/dynamic/public';

export const load: LayoutServerLoad = async ({ locals, depends }) => {
	depends('app:session');
	return {
		user: locals.user
			? { id: locals.user.id, name: locals.user.name, email: locals.user.email }
			: null,
		household: locals.household,
		memberships: locals.memberships,
		pollMs: Math.max(3000, Number(env.PUBLIC_REVISION_POLL_MS ?? 20000) || 20000)
	};
};
