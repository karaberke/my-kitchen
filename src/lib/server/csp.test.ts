import { describe, expect, it } from 'vitest';
import config from '../../../svelte.config.js';

/**
 * A social sign-in is a form POST to ?/social whose response is a 303 to the
 * provider. Chrome and Safari check `form-action` against the *redirect* target
 * as well as the form's own action, so a provider origin missing here makes the
 * button do nothing at all — no error, no navigation. Firefox does not check
 * redirects, which is why this can look like it works on a desktop and fail on
 * every phone.
 */
const AUTHORIZE_ORIGINS: Record<string, string> = {
	google: 'https://accounts.google.com',
	microsoft: 'https://login.microsoftonline.com',
	apple: 'https://appleid.apple.com'
};

const formAction = (config.kit?.csp?.directives?.['form-action'] ?? []) as string[];
const scriptSrc = (config.kit?.csp?.directives?.['script-src'] ?? []) as string[];

describe('csp form-action', () => {
	it('still allows the app to post to itself', () => {
		expect(formAction).toContain('self');
	});

	it.each(Object.entries(AUTHORIZE_ORIGINS))('allows the redirect to %s', (_provider, origin) => {
		expect(formAction).toContain(origin);
	});

	it('covers every provider the app is willing to link', async () => {
		// Keeps the two lists honest: adding a provider to auth.ts without adding
		// its origin here would otherwise ship a button that silently does nothing.
		const source = await import('node:fs').then((fs) =>
			fs.readFileSync('src/lib/server/auth.ts', 'utf8')
		);
		const listed = /trustedProviders:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
		const providers = [...listed.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

		expect(providers.length).toBeGreaterThan(0);
		for (const p of providers) {
			expect(AUTHORIZE_ORIGINS, `no authorize origin known for '${p}'`).toHaveProperty(p);
			expect(formAction).toContain(AUTHORIZE_ORIGINS[p]);
		}
	});
});

describe('csp script-src', () => {
	it('lets the barcode reader compile its WebAssembly', () => {
		// Without this Chrome refuses the compile and the scanner never starts,
		// while Safari carries on, so the failure looks device-specific.
		expect(scriptSrc).toContain('wasm-unsafe-eval');
	});

	it('still refuses arbitrary script origins', () => {
		expect(scriptSrc).toContain('self');
		expect(scriptSrc).not.toContain('unsafe-eval');
		expect(scriptSrc).not.toContain('unsafe-inline');
	});
});

describe('permissions policy', () => {
	it('grants the camera to this origin and nothing else', async () => {
		const { applyResponsePolicy } = await import('./http');
		const event = { url: new URL('https://kitchen.example.test/pantry') } as never;
		const policy = applyResponsePolicy(event, new Response('')).headers.get('permissions-policy');
		expect(policy).toContain('camera=(self)');
		expect(policy).toContain('microphone=()');
		expect(policy).toContain('geolocation=()');
	});
});
