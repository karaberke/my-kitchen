import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against a production build (`pnpm build` first) using
 * the test database. Start: `pnpm test:e2e`.
 */
export default defineConfig({
	testDir: 'tests/e2e',
	timeout: 60_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'retain-on-failure',
		...devices['Desktop Chrome']
	},
	webServer: {
		command:
			"node --env-file=.env.test scripts/migrate.mjs && node --env-file=.env.test -e \"process.env.PORT=4173; process.env.BODY_SIZE_LIMIT='6M'; import('./build/index.js')\"",
		url: 'http://localhost:4173/health',
		reuseExistingServer: !process.env.CI,
		timeout: 60_000
	}
});
