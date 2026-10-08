import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SvelteKit refuses every POST to a page whose `actions` has both `default`
 * and a named action ("When using named actions, the default action cannot be
 * used"), so one added named action breaks the page's existing save as well.
 * The pages are read as text (the glob only lists them): importing them would
 * need the database.
 */
const pages = import.meta.glob('./**/+page.server.ts');

function actionNames(source: string): string[] {
	const block = /export const actions[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1];
	if (!block) return [];
	return [...block.matchAll(/^\t(\w+):\s*async\b/gm)].map((m) => m[1]);
}

describe('form actions', () => {
	it('finds the action names of a page', () => {
		expect(
			actionNames(
				'export const actions: Actions = {\n\tsave: async (e) => {},\n\taiFix: async (e) => {}\n};'
			)
		).toEqual(['save', 'aiFix']);
	});

	it.each(Object.keys(pages))('%s does not mix default and named actions', (path) => {
		const names = actionNames(readFileSync(new URL(path, import.meta.url), 'utf8'));
		if (names.includes('default')) expect(names).toEqual(['default']);
	});
});
