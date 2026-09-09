import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

function loadDotenv(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		for (const line of readFileSync(path, 'utf8').split('\n')) {
			const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
			if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
		}
	} catch {
		/* no file */
	}
	return out;
}

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		projects: [
			{
				extends: true,
				test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' }
			},
			{
				extends: true,
				test: {
					name: 'integration',
					include: ['tests/integration/**/*.test.ts'],
					environment: 'node',
					env: loadDotenv('.env.test'),
					setupFiles: ['tests/integration/setup.ts'],
					fileParallelism: false,
					testTimeout: 30000,
					hookTimeout: 60000
				}
			}
		]
	}
});
