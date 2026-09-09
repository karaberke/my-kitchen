import { afterAll } from 'vitest';

if (!process.env.DATABASE_URL?.includes('recipe_test')) {
	throw new Error('Integration tests must run against the recipe_test database (see .env.test)');
}

afterAll(async () => {
	const { closeDb } = await import('$lib/server/db');
	await closeDb();
});
