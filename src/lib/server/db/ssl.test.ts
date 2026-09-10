import { describe, expect, it } from 'vitest';
import { sslOptions } from './ssl';

/**
 * postgres.js maps the strings 'require' | 'allow' | 'prefer' to
 * rejectUnauthorized:false — TLS with no certificate check at all. Anything that
 * asks for TLS must therefore come back as an object that verifies.
 */
describe('sslOptions', () => {
	it('disables TLS only when unset', () => {
		expect(sslOptions('')).toBeUndefined();
		expect(sslOptions('   ')).toBeUndefined();
	});

	it('verifies the certificate for every TLS mode except no-verify', () => {
		for (const mode of ['require', 'verify-full', 'true', '1', 'REQUIRE'])
			expect(sslOptions(mode)).toEqual({ rejectUnauthorized: true });
	});

	it('skips verification only for an explicit no-verify', () => {
		expect(sslOptions('no-verify')).toEqual({ rejectUnauthorized: false });
		expect(sslOptions(' No-Verify ')).toEqual({ rejectUnauthorized: false });
	});

	it('never returns a bare string, which postgres.js would read as unverified', () => {
		for (const mode of ['require', 'no-verify', 'verify-full'])
			expect(typeof sslOptions(mode)).toBe('object');
	});
});
