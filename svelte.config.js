import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter({ precompress: true }),
		csrf: { trustedOrigins: [] },
		/**
		 * Containment layer, not the primary defence — the app renders no
		 * user HTML (no {@html}, no innerHTML anywhere in src/). SvelteKit adds a
		 * nonce to its own hydration script; everything else is same-origin.
		 *   style-src      Google Fonts serves the stylesheet linked in app.html
		 *   style-src-attr the two static `style=` attributes (app.html, recipe page)
		 *   font-src       where that stylesheet fetches the font files from
		 *   connect-src    the /api/revisions poll
		 */
		csp: {
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self', 'https://fonts.googleapis.com'],
				'style-src-attr': ['unsafe-inline'],
				'font-src': ['self', 'https://fonts.gstatic.com'],
				'img-src': ['self', 'data:'],
				'connect-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['none']
			}
		},
		typescript: {
			config: (config) => {
				config.include.push(
					'../drizzle.config.ts',
					'../vitest.config.ts',
					'../playwright.config.ts'
				);
				return config;
			}
		}
	}
};

export default config;
