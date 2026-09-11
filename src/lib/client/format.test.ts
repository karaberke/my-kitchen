import { describe, expect, it } from 'vitest';
import { ownerShareLabel } from './format';

describe('ownerShareLabel', () => {
	it('names the households that other people can read', () => {
		expect(
			ownerShareLabel([
				{ name: 'Beach house', shared: true, memberCount: 3 },
				{ name: 'Book club', shared: true, memberCount: 2 },
				{ name: 'Work', shared: false, memberCount: 4 }
			])
		).toBe('Yours · shared with Beach house, Book club');
	});

	it('announces nothing for a household the owner is alone in', () => {
		expect(ownerShareLabel([{ name: "Berke's kitchen", shared: true, memberCount: 1 }])).toBe(
			'Yours'
		);
	});

	it('calls an unshared recipe private', () => {
		expect(ownerShareLabel([{ name: "Berke's kitchen", shared: false, memberCount: 1 }])).toBe(
			'Yours · private'
		);
	});
});
