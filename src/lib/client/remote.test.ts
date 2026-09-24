import { describe, expect, it } from 'vitest';
import type { RemoteQuery } from '@sveltejs/kit';
import { fetchFresh } from './remote';

/** A query whose refresh settles into the given state. */
function fakeQuery<T>(state: { ready: boolean; current?: T; error?: unknown }): RemoteQuery<T> {
	return { ...state, refresh: async () => {} } as unknown as RemoteQuery<T>;
}

describe('fetchFresh', () => {
	it('returns the answer of the refresh', async () => {
		expect(await fetchFresh(fakeQuery({ ready: true, current: { pantry: 3 } }))).toEqual({
			pantry: 3
		});
	});

	it('throws instead of returning undefined when the refresh brought no answer', async () => {
		const error = new Error('offline');
		await expect(fetchFresh(fakeQuery({ ready: false, error }))).rejects.toBe(error);
		await expect(fetchFresh(fakeQuery({ ready: false }))).rejects.toThrow(
			'No answer from the server'
		);
	});
});
