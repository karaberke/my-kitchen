/**
 * TLS options for a postgres.js connection, from DATABASE_SSL.
 *
 *   (empty)      no TLS
 *   no-verify    TLS, certificate NOT checked (self-signed / private CA)
 *   anything     TLS with full certificate and hostname verification
 *   else         (require, verify-full, true, 1 ...)
 *
 * postgres.js maps the *strings* 'require' | 'allow' | 'prefer' to
 * rejectUnauthorized:false, so a verified connection has to be requested as an
 * object. Passing the string through would silently accept any certificate.
 * Shared by the app (src/lib/server/db/index.ts keeps a typed copy) and every
 * maintenance script so the mapping cannot drift apart again.
 */
export function sslOptions(value) {
	const mode = (value ?? '').trim().toLowerCase();
	if (!mode) return undefined;
	if (mode === 'no-verify') return { rejectUnauthorized: false };
	return { rejectUnauthorized: true };
}
