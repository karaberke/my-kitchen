import { fail } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { assertMember, requireHousehold } from '$lib/server/access';
import { getHistory } from '$lib/server/pantry';
import { undoEvent } from '$lib/server/undo';
import { ReviewConflict, asAppError } from '$lib/server/errors';
import { isOperationId } from '$lib/server/operations';

const loadImpl = async (event: PageServerLoadEvent) => {
	const { user, household } = requireHousehold(event);
	event.depends('app:history');
	await assertMember(db, household.id, user.id);
	const before = event.url.searchParams.get('before');
	let cursor: { occurredAt: string; id: string } | null = null;
	if (before) {
		const [occurredAt, id] = before.split('|');
		if (occurredAt && id) cursor = { occurredAt, id };
	}
	const history = await getHistory(db, household.id, cursor, 30);
	return { title: 'Inventory history', history, operationId: randomUUID() };
};

export const actions: Actions = {
	undo: async (event) => {
		const { user, household } = requireHousehold(event);
		const fd = await event.request.formData();
		const operationId = String(fd.get('operationId') ?? '');
		if (!isOperationId(operationId)) return fail(400, { message: 'Missing operation id' });
		try {
			await undoEvent(
				{ userId: user.id, actorName: user.name, householdId: household.id },
				{ operationId, eventId: String(fd.get('eventId') ?? '') }
			);
			return { ok: true };
		} catch (err) {
			if (err instanceof ReviewConflict)
				return fail(409, { message: err.message, review: err.review });
			const app = asAppError(err);
			if (app) return fail(app.status, { message: app.message });
			throw err;
		}
	}
};

export const load = guard(loadImpl);
