import { fail } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { assertMember, requireHousehold } from '$lib/server/access';
import { getHistory } from '$lib/server/pantry';
import { undoEvent } from '$lib/server/undo';
import { AppError, ReviewConflict } from '$lib/server/errors';
import { isOperationId } from '$lib/server/operations';

export const load: PageServerLoad = async (event) => {
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
			if (err instanceof AppError) return fail(err.status, { message: err.message });
			throw err;
		}
	}
};
