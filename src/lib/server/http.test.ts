import { describe, expect, it } from 'vitest';
import { isRedirect, redirect } from '@sveltejs/kit';
import { actionError, safeNext } from '$lib/server/http';
import { AppError, ReviewConflict } from '$lib/server/errors';

describe('actionError', () => {
	it('maps a ReviewConflict to 409 with the review payload', () => {
		const conflict = new ReviewConflict('Stale data', { revision: 3 });
		const result = actionError(conflict) as { status: number; data: unknown };
		expect(result.status).toBe(409);
		expect(result.data).toEqual({ message: 'Stale data', review: { revision: 3 } });
	});

	it('maps an AppError to its own status', () => {
		const result = actionError(new AppError(403, 'Nope')) as { status: number; data: unknown };
		expect(result.status).toBe(403);
		expect(result.data).toEqual({ message: 'Nope' });
	});

	it('names the form when the action gives one', () => {
		const app = actionError(new AppError(400, 'Name the item'), 'addLine') as { data: unknown };
		expect(app.data).toEqual({ message: 'Name the item', form: 'addLine' });
		const review = actionError(new ReviewConflict('Stale', { revision: 2 }), 'purchase') as {
			data: unknown;
		};
		expect(review.data).toEqual({ message: 'Stale', review: { revision: 2 }, form: 'purchase' });
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
