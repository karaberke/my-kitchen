import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertTestDatabaseName, assertTestDatabaseUrl } from '../../scripts/test-database.mjs';

const run = promisify(execFile);

describe('test database safeguards', () => {
	it.each([
		'postgres://user:password@127.0.0.1:5433/recipe_test',
		'postgresql://user:password@localhost/recipe_test?sslmode=require'
	])('accepts an exact test database URL: %s', (url) => {
		expect(assertTestDatabaseUrl(url)).toBe(url);
	});

	it.each([
		undefined,
		'',
		'recipe_test',
		'postgres:/recipe_test',
		'postgres://recipe_test:password@localhost/recipe_prod',
		'postgres://user:recipe_test@localhost/recipe_prod',
		'postgres://recipe_test.example/recipe_prod',
		'postgres://localhost/recipe_test_old',
		'postgres://localhost/recipe_test/nested',
		'postgres://localhost/%72ecipe_test',
		'postgres://localhost/recipe_prod?tag=recipe_test',
		'postgres://localhost/recipe_prod#recipe_test',
		'https://localhost/recipe_test',
		'postgres://localhost/recipe_test?database=recipe_prod',
		'postgres://localhost/recipe_test?DATABASE=recipe_prod',
		'postgres://localhost/recipe_test?%64atabase=recipe_prod',
		'postgres://localhost/recipe_test?db=recipe_prod',
		'postgres://localhost/recipe_test?dbname=recipe_prod'
	])('rejects a URL that could select a different database: %s', (url) => {
		expect(() => assertTestDatabaseUrl(url)).toThrow(
			'Test commands require DATABASE_URL to select recipe_test.'
		);
	});

	it('does not include credentials in a refusal', () => {
		const url = 'postgres://recipe_test:private-password@localhost/recipe_prod';
		try {
			assertTestDatabaseUrl(url);
			throw new Error('expected a refusal');
		} catch (err) {
			expect((err as Error).message).toBe(
				'Test commands require DATABASE_URL to select recipe_test.'
			);
			expect(String(err)).not.toContain('private-password');
		}
	});

	it('accepts only the actual test database name', () => {
		expect(() => assertTestDatabaseName('recipe_test')).not.toThrow();
		for (const name of ['recipe_dev', 'recipe_test_old', null, undefined]) {
			expect(() => assertTestDatabaseName(name)).toThrow(
				'Test commands require the connected database to be recipe_test.'
			);
		}
	});

	it.each([
		['migrate.mjs', ['--test']],
		['test-server.mjs', []]
	] as const)(
		'%s rejects an inherited unsafe URL before database or app startup',
		async (script, args) => {
			const result = await run(
				process.execPath,
				[fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url)), ...args],
				{
					env: {
						...process.env,
						DATABASE_URL: 'postgres://recipe_test:private-password@127.0.0.1/recipe_prod'
					},
					timeout: 10_000
				}
			).then(
				() => ({ code: 0, stderr: '' }),
				(err: { code: number; stderr: string }) => err
			);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('Test commands require DATABASE_URL to select recipe_test.');
			expect(result.stderr).not.toContain('private-password');
		}
	);
});
