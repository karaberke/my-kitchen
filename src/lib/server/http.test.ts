import { describe, expect, it } from 'vitest';
import { isRedirect, redirect } from '@sveltejs/kit';
import { actionError, safeNext } from '$lib/server/http';
import { AppError, ReviewConflict } from '$lib/server/errors';

describe('actionError', () => {
	it('maps a ReviewConflict to 409 with the review payload', () => {
		const conflict = new ReviewConflict('Stale data', { stale: true });
		const result = actionError(conflict) as { status: number; data: unknown };
		expect(result.status).toBe(409);
		expect(result.data).toEqual({ message: 'Stale data', review: { stale: true } });
	});

	it('maps an AppError to its own status', () => {
		const result = actionError(new AppError(403, 'Nope')) as { status: number; data: unknown };
		expect(result.status).toBe(403);
		expect(result.data).toEqual({ message: 'Nope' });
	});

	it('rethrows anything else', () => {
		expect(() => actionError(new Error('boom'))).toThrowError('boom');
	});

	it('rethrows a redirect untouched', () => {
		let caught: unknown;
		try {
			redirect(303, '/somewhere');
		} catch (err) {
			caught = err;
		}
		expect(isRedirect(caught)).toBe(true);
		let rethrown: unknown;
		try {
			actionError(caught);
		} catch (err) {
			rethrown = err;
		}
		expect(rethrown).toBe(caught);
	});
});

describe('safeNext', () => {
	it('keeps a same-origin path with query and hash', () => {
		expect(safeNext('/recipes/1?x=1#y')).toBe('/recipes/1?x=1#y');
	});

	it('falls back for null, empty, and cross-origin values', () => {
		expect(safeNext(null)).toBe('/recipes');
		expect(safeNext('')).toBe('/recipes');
		expect(safeNext('https://evil.com')).toBe('/recipes');
		expect(safeNext('//evil.com')).toBe('/recipes');
		expect(safeNext('/\\evil.com')).toBe('/recipes');
		expect(safeNext('/\t/evil.com')).toBe('/recipes');
	});
});
