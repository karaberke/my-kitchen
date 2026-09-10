/**
 * TLS options from DATABASE_SSL. Mirrors scripts/db-ssl.mjs (the maintenance
 * scripts run outside the bundle and cannot import from $lib).
 *
 *   (empty)      no TLS
 *   no-verify    TLS, certificate NOT checked (self-signed / private CA)
 *   else         TLS with full certificate and hostname verification
 *
 * postgres.js maps the *strings* 'require' | 'allow' | 'prefer' to
 * rejectUnauthorized:false, so a verified connection must be asked for as an
 * object; passing 'require' straight through would accept any certificate.
 */
export function sslOptions(value: string): { rejectUnauthorized: boolean } | undefined {
	const mode = value.trim().toLowerCase();
	if (!mode) return undefined;
	return { rejectUnauthorized: mode !== 'no-verify' };
}
