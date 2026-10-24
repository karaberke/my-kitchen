export const TEST_DATABASE_NAME = 'recipe_test';

/** @param {string | undefined} value */
export function assertTestDatabaseUrl(value) {
	let url;
	try {
		url = new URL(value ?? '');
	} catch {
		// Every refusal uses a fixed message; connection strings contain secrets.
	}
	if (
		!url ||
		!['postgres:', 'postgresql:'].includes(url.protocol) ||
		!url.hostname ||
		url.pathname !== `/${TEST_DATABASE_NAME}` ||
		[...url.searchParams.keys()].some((key) =>
			['database', 'db', 'dbname'].includes(key.toLowerCase())
		)
	) {
		throw new Error('Test commands require DATABASE_URL to select recipe_test.');
	}
	return /** @type {string} */ (value);
}

/** @param {unknown} name */
export function assertTestDatabaseName(name) {
	if (name !== TEST_DATABASE_NAME) {
		throw new Error('Test commands require the connected database to be recipe_test.');
	}
}
