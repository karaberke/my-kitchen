import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const certDir = mkdtempSync(join(realpathSync(tmpdir()), 'my-kitchen-egress-'));
function openssl(args) {
	execFileSync('openssl', args, { cwd: certDir, stdio: ['ignore', 'ignore', 'pipe'] });
}

let child;
function cancel(signal) {
	child?.kill(signal);
}
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);

try {
	openssl([
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-sha256',
		'-keyout',
		'ca.key',
		'-out',
		'ca.pem',
		'-days',
		'1',
		'-subj',
		'/CN=My Kitchen synthetic egress test CA',
		'-addext',
		'basicConstraints=critical,CA:TRUE',
		'-addext',
		'keyUsage=critical,keyCertSign,cRLSign'
	]);
	openssl([
		'req',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-sha256',
		'-keyout',
		'server.key',
		'-out',
		'server.csr',
		'-subj',
		'/CN=recipe.test'
	]);
	writeFileSync(
		join(certDir, 'server.ext'),
		[
			'basicConstraints=critical,CA:FALSE',
			'keyUsage=critical,digitalSignature,keyEncipherment',
			'extendedKeyUsage=serverAuth',
			'subjectAltName=DNS:recipe.test,DNS:challenge.test,DNS:mixed.test,DNS:rebind.test,DNS:badcert.test'
		].join('\n')
	);
	openssl([
		'x509',
		'-req',
		'-in',
		'server.csr',
		'-CA',
		'ca.pem',
		'-CAkey',
		'ca.key',
		'-CAcreateserial',
		'-out',
		'server.pem',
		'-days',
		'1',
		'-sha256',
		'-extfile',
		'server.ext'
	]);
	openssl([
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-sha256',
		'-keyout',
		'untrusted.key',
		'-out',
		'untrusted.pem',
		'-days',
		'1',
		'-subj',
		'/CN=badcert.test',
		'-addext',
		'subjectAltName=DNS:badcert.test'
	]);
	const proxyUrl = process.env.EGRESS_PROXY_URL ?? 'http://smokescreen:4750';
	child = spawn('pnpm', ['test:egress:run'], {
		stdio: 'inherit',
		env: {
			...process.env,
			DATABASE_URL:
				process.env.DATABASE_URL ?? 'postgres://synthetic:synthetic@127.0.0.1:5432/recipe_egress',
			BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'synthetic-egress-acceptance-secret',
			ORIGIN: 'http://recipe.test',
			IMPORT_PROXY_URL: proxyUrl,
			EGRESS_PROXY_URL: proxyUrl,
			EGRESS_CERT_DIR: certDir,
			SSL_CERT_FILE: join(certDir, 'ca.pem'),
			NODE_EXTRA_CA_CERTS: join(certDir, 'ca.pem')
		}
	});
	process.exitCode = await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (code) => resolve(code ?? 1));
	});
} finally {
	process.off('SIGINT', cancel);
	process.off('SIGTERM', cancel);
	// This directory was created by this launcher, never supplied by an environment variable.
	if (dirname(certDir) === realpathSync(tmpdir()))
		rmSync(certDir, { recursive: true, force: true });
}
