import { actionError, guard } from '$lib/server/http';
import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { assertMember, requireHousehold } from '$lib/server/access';
import { getHistory } from '$lib/server/pantry';
import { undoEvent } from '$lib/server/undo';
import { operationIdFrom } from '$lib/server/operations';

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
		try {
			const operationId = operationIdFrom(fd);
			await undoEvent(
				{ userId: user.id, actorName: user.name, householdId: household.id },
				{ operationId, eventId: String(fd.get('eventId') ?? '') }
			);
			return { ok: true };
		} catch (err) {
			return actionError(err);
		}
	}
};

export const load = guard(loadImpl);
