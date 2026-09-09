#!/usr/bin/env node
/**
 * Measures warm server response times against a running instance, using the
 * perf seed's first user. Reports p50/p95, payload sizes, and the size of an
 * unchanged revision poll. Usage:
 *   node --env-file=.env scripts/measure.mjs --base http://localhost:3000 --runs 30
 */
const args = Object.fromEntries(
	process.argv
		.slice(2)
		.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : []))
		.filter((x) => x.length)
);
const BASE = args.base ?? 'http://localhost:3000';
const RUNS = Number(args.runs ?? 30);
const EMAIL = args.email ?? 'perf1@example.test';
const PASSWORD = args.password ?? 'perf-password-1';

const jar = new Map();
function cookieHeader() {
	return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeCookies(res) {
	for (const c of res.headers.getSetCookie?.() ?? []) {
		const [pair] = c.split(';');
		const [k, v] = pair.split('=');
		jar.set(k.trim(), v);
	}
}
async function req(path, init = {}) {
	const t0 = performance.now();
	const res = await fetch(BASE + path, {
		...init,
		redirect: 'manual',
		headers: { cookie: cookieHeader(), origin: BASE, ...(init.headers ?? {}) }
	});
	const body = await res.arrayBuffer();
	const ms = performance.now() - t0;
	storeCookies(res);
	return { res, ms, bytes: body.byteLength, text: () => Buffer.from(body).toString('utf8') };
}
function stats(samples) {
	const s = [...samples].sort((a, b) => a - b);
	const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	return { p50: q(0.5).toFixed(1), p95: q(0.95).toFixed(1), max: s[s.length - 1].toFixed(1) };
}

// sign in through the Better Auth endpoint
const login = await req('/api/auth/sign-in/email', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ email: EMAIL, password: PASSWORD })
});
if (login.res.status !== 200) {
	console.error('login failed', login.res.status, login.text().slice(0, 200));
	process.exit(1);
}
const grocery = await req('/grocery');
const listPath = grocery.res.headers.get('location') ?? '/grocery';
const targets = [
	['recipes page 1 (HTML)', '/recipes'],
	['recipes page 1 (data)', '/recipes/__data.json'],
	['recipes search', '/recipes/__data.json?q=chicken'],
	['pantry (data)', '/pantry/__data.json'],
	['shopping list (data)', `${listPath}/__data.json`],
	['revision poll', '/api/revisions']
];
console.log(`base ${BASE}, runs ${RUNS}, user ${EMAIL}`);
console.log(`node ${process.version}, ${process.platform} ${process.arch}`);
for (const [label, path] of targets) {
	await req(path); // warm
	const times = [];
	let bytes = 0;
	let status = 0;
	for (let i = 0; i < RUNS; i++) {
		const r = await req(path);
		times.push(r.ms);
		bytes = r.bytes;
		status = r.res.status;
	}
	const st = stats(times);
	console.log(
		`${label.padEnd(26)} status ${status}  p50 ${st.p50} ms  p95 ${st.p95} ms  max ${st.max} ms  payload ${bytes} bytes`
	);
}
