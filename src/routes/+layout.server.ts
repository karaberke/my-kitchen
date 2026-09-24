import type { LayoutServerLoadEvent } from './$types';
import { guard } from '$lib/server/http';
import { revisionPollMs } from '$lib/server/env';

const loadImpl = async ({ locals, depends }: LayoutServerLoadEvent) => {
	depends('app:session');
	return {
		user: locals.user
			? { id: locals.user.id, name: locals.user.name, email: locals.user.email }
			: null,
		household: locals.household,
		memberships: locals.memberships,
		pollMs: revisionPollMs()
	};
};

export const load = guard(loadImpl);
