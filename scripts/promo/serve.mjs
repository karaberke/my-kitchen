#!/usr/bin/env node
/** Start an isolated, local recording instance without reading or changing .env files. */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertPromoDatabase,
	PROMO_BASE_URL,
	PROMO_OLLAMA_BASE_URL,
	PROMO_OUTPUT_DIR
} from './utils.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = PROMO_OUTPUT_DIR;
const runtimePath = path.join(output, 'runtime.json');
let previous = {};
try {
	previous = JSON.parse(await readFile(runtimePath, 'utf8'));
} catch (error) {
	if (error.code !== 'ENOENT') throw error;
}

const databaseUrl = process.env.PROMO_DATABASE_URL ?? previous.databaseUrl;
if (!databaseUrl) throw new Error('Set PROMO_DATABASE_URL to an existing isolated promo database.');
const database = assertPromoDatabase(databaseUrl);

const model = process.env.PROMO_LLM_MODEL ?? previous.model ?? 'qwen2.5:7b';
const baseUrl = PROMO_BASE_URL;
const ollamaBaseUrl = PROMO_OLLAMA_BASE_URL;
Object.assign(process.env, {
	DATABASE_URL: databaseUrl,
	DATABASE_SSL: '',
	ORIGIN: baseUrl,
	BETTER_AUTH_SECRET: randomBytes(48).toString('hex'),
	REGISTRATION_OPEN: 'true',
	ADMIN_EMAIL: '',
	ADMIN_NAME: '',
	ADMIN_PASSWORD: '',
	GOOGLE_CLIENT_ID: '',
	GOOGLE_CLIENT_SECRET: '',
	MICROSOFT_CLIENT_ID: '',
	MICROSOFT_CLIENT_SECRET: '',
	APPLE_CLIENT_ID: '',
	APPLE_CLIENT_SECRET: '',
	STORAGE_BACKEND: 'local',
	UPLOAD_DIR: './artifacts/promo/uploads',
	S3_BUCKET: '',
	S3_REGION: '',
	S3_ENDPOINT: '',
	S3_ACCESS_KEY_ID: '',
	S3_SECRET_ACCESS_KEY: '',
	USDA_API_KEY: '',
	OFF_ENABLED: 'false',
	OFF_CONTACT: '',
	ADDRESS_HEADER: '',
	LLM_BASE_URL: ollamaBaseUrl,
	LLM_API_KEY: 'ollama',
	LLM_MODEL: model
});

const { createServer } = await import('vite');
const server = await createServer({
	root,
	envDir: false,
	server: {
		host: new URL(baseUrl).hostname,
		port: Number(new URL(baseUrl).port),
		strictPort: true,
		watch: {
			ignored: [
				'**/artifacts/promo/**',
				'**/scripts/promo/**',
				'**/research_notes/**',
				'**/reports/**'
			]
		}
	}
});
await server.listen();
await mkdir(output, { recursive: true });
await writeFile(
	runtimePath,
	`${JSON.stringify(
		{
			baseUrl,
			databaseUrl,
			model,
			ollamaBaseUrl,
			appPid: process.pid,
			databaseName: database.pathname.slice(1)
		},
		null,
		2
	)}\n`
);
console.log(`Promo server: ${baseUrl}; local assistant: ${model}; PID ${process.pid}`);
console.log('Runtime metadata: artifacts/promo/runtime.json');

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, async () => {
		await server.close();
		process.exit(0);
	});
}
