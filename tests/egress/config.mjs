import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	DNS_PORT,
	FIXTURE_HOST,
	HTTP_PORT,
	HTTPS_PORT,
	UNTRUSTED_HTTPS_PORT
} from './settings.mjs';

/** Extend a copy of the production policy with exact endpoints on the isolated test network. */
export function writeEgressConfig(source, destination) {
	const policy = readFileSync(source, 'utf8')
		// Keep policy-denial tests independent of global throttling on this isolated network.
		.replace(/^max_request_rate: .+$/m, 'max_request_rate: 1000')
		.replace(/^max_request_burst: .+$/m, 'max_request_burst: 2000');
	if (/^(?:allow_ranges|allow_addresses|resolver_addresses):/m.test(policy))
		throw new Error(
			'The production policy must not contain address exceptions or custom resolvers'
		);
	const allowed = [HTTP_PORT, HTTPS_PORT, UNTRUSTED_HTTPS_PORT]
		.map((port) => `  - '${FIXTURE_HOST}:${port}'`)
		.join('\n');
	writeFileSync(
		destination,
		`${policy}\nresolver_addresses:\n  - '${FIXTURE_HOST}:${DNS_PORT}'\nallow_addresses:\n${allowed}\n`
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [source, destination] = process.argv.slice(2);
	if (!source || !destination) throw new Error('Usage: config.mjs <production.yaml> <test.yaml>');
	writeEgressConfig(source, destination);
}
