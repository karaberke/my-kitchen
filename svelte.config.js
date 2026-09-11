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
		 *   connect-src    the /api/revisions poll and the /api/barcode lookup
		 *   script-src     'wasm-unsafe-eval' lets the barcode reader compile its
		 *                  WebAssembly. Chrome refuses a WebAssembly.compile under a
		 *                  strict script-src without it; Safari does not check, which
		 *                  is what would make this look like an Android-only bug. It
		 *                  permits WebAssembly only, not eval of JavaScript, and the
		 *                  .wasm file itself is same-origin like every other asset.
		 *   form-action    the social sign-in providers, see below
		 */
		csp: {
			directives: {
				'default-src': ['self'],
				'script-src': ['self', 'wasm-unsafe-eval'],
				'style-src': ['self', 'https://fonts.googleapis.com'],
				'style-src-attr': ['unsafe-inline'],
				'font-src': ['self', 'https://fonts.gstatic.com'],
				'img-src': ['self', 'data:'],
				'connect-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				/**
				 * `self` alone is not enough. "Continue with Google" is a form POST to
				 * ?/social whose response is a 303 to the provider, and Chrome and Safari
				 * check form-action against the redirect target too — so the browser
				 * silently refuses the hop and the button appears to do nothing. Firefox
				 * does not check redirects, which is what makes this look like a phone-only
				 * bug. Listing an origin here permits nothing on its own; a provider still
				 * only appears once its credentials are set.
				 */
				'form-action': [
					'self',
					'https://accounts.google.com',
					'https://login.microsoftonline.com',
					'https://appleid.apple.com'
				],
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
