#!/usr/bin/env node
/**
 * Container entrypoint. Compose cannot omit a variable, only pass it empty, and
 * adapter-node treats an empty ORIGIN as invalid rather than unset. Drop empty
 * optional variables, then start the SvelteKit server.
 */
for (const key of ['ORIGIN', 'PROTOCOL_HEADER', 'HOST_HEADER', 'PORT_HEADER', 'DATABASE_SSL']) {
	if (process.env[key] !== undefined && process.env[key].trim() === '') delete process.env[key];
}
if (!process.env.ORIGIN) {
	console.log(
		'start: ORIGIN is not set; trusting the request origin forwarded by the proxy/tunnel (X-Forwarded-Proto + Host)'
	);
}
await import('../build/index.js');
