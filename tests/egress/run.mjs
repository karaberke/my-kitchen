import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../..', import.meta.url));
const project = `my-kitchen-egress-${process.pid}-${randomBytes(4).toString('hex')}`;
const compose = [
	'compose',
	'--env-file',
	process.platform === 'win32' ? 'NUL' : '/dev/null',
	'--project-name',
	project,
	'--file',
	'tests/egress/compose.yaml'
];
let child;
let cancelled = false;

function cancel() {
	cancelled = true;
	child?.kill('SIGTERM');
}
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);

function docker(args) {
	return new Promise((resolve, reject) => {
		child = spawn('docker', args, { cwd, stdio: 'inherit' });
		child.once('error', reject);
		child.once('exit', (code) => {
			child = undefined;
			resolve(code ?? 1);
		});
	});
}

let started = false;
try {
	const built = await docker([
		'build',
		'--file',
		'deploy/smokescreen/Dockerfile',
		'--tag',
		'my-kitchen-smokescreen:0.1.0',
		'deploy/smokescreen'
	]);
	if (built !== 0 || cancelled) process.exitCode = built || 1;
	else {
		started = true;
		process.exitCode = await docker([
			...compose,
			'up',
			'--build',
			'--attach',
			'runner',
			'--abort-on-container-exit',
			'--exit-code-from',
			'runner'
		]);
	}
} catch (err) {
	console.error('Egress acceptance infrastructure failed:', err.message);
	process.exitCode = 1;
} finally {
	if (started) {
		const cleaned = await docker([...compose, 'down', '--remove-orphans', '--timeout', '5']).catch(
			() => 1
		);
		if (cleaned !== 0) process.exitCode = 1;
	}
	process.off('SIGINT', cancel);
	process.off('SIGTERM', cancel);
}
