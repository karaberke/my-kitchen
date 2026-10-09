import { actionError, formText, guard } from '$lib/server/http';
import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { householdActor, requireMember } from '$lib/server/access';
import { getHistory } from '$lib/server/pantry';
import { undoEvent } from '$lib/server/undo';
import { operationIdFrom } from '$lib/server/operations';

export const load = guard(async (event: PageServerLoadEvent) => {
	event.depends('app:history');
	const { household } = await requireMember(db, event);
	const before = event.url.searchParams.get('before');
	let cursor: { occurredAt: string; id: string } | null = null;
	if (before) {
		const [occurredAt, id] = before.split('|');
		if (occurredAt && id) cursor = { occurredAt, id };
	}
	const history = await getHistory(db, household.id, cursor, 30);
	return { title: 'Inventory history', history, operationId: randomUUID() };
});

export const actions: Actions = {
	undo: async (event) => {
		const actor = householdActor(event);
		const fd = await event.request.formData();
		try {
			const operationId = operationIdFrom(fd);
			await undoEvent(actor, { operationId, eventId: formText(fd, 'eventId') });
			return { ok: true };
		} catch (err) {
			return actionError(err);
		}
	}
};
