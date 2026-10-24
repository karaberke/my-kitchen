import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		name: 'egress',
		include: ['tests/egress/*.test.ts'],
		environment: 'node',
		fileParallelism: false,
		testTimeout: 30000,
		hookTimeout: 60000
	}
});
