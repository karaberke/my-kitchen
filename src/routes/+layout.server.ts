import type { LayoutServerLoadEvent } from './$types';
import { guard } from '$lib/server/http';
import { revisionPollMs } from '$lib/server/env';

export const load = guard(async ({ locals, depends }: LayoutServerLoadEvent) => {
	depends('app:session');
	return {
		user: locals.user
			? { id: locals.user.id, name: locals.user.name, email: locals.user.email }
			: null,
		household: locals.household,
		memberships: locals.memberships,
		pollMs: revisionPollMs()
	};
});
