import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHAT_STUB_API_KEY, CHAT_STUB_BASE_URL, CHAT_STUB_MODEL } from '../helpers/chat-stub';

const run = promisify(execFile);
const launcherUrl = new URL('../../scripts/test-server.mjs', import.meta.url).href;

describe('browser test server assistant configuration', () => {
	it.each([false, true])(
		'isolates inherited model servers when the chat stub is %s',
		async (chatStub) => {
			const { stdout } = await run(
				process.execPath,
				[
					'--input-type=module',
					'--eval',
					`
					import { registerHooks } from 'node:module';
					registerHooks({
						resolve(specifier, context, nextResolve) {
							if (specifier === '../build/index.js' && context.parentURL === ${JSON.stringify(launcherUrl)}) {
								return { url: 'test:app', shortCircuit: true };
							}
							return nextResolve(specifier, context);
						},
						load(url, context, nextLoad) {
							if (url === 'node:child_process') {
								return { format: 'module', source: 'export const spawnSync = () => ({ status: 0 });', shortCircuit: true };
							}
							if (url === 'test:app') {
								return {
									format: 'module',
									source: \`process.stdout.write(JSON.stringify({
										baseUrl: process.env.LLM_BASE_URL,
										fallbackBaseUrl: process.env.LLM_FALLBACK_BASE_URL,
										apiKey: process.env.LLM_API_KEY,
										model: process.env.LLM_MODEL
									})); process.emit('SIGTERM');\`,
									shortCircuit: true
								};
							}
							return nextLoad(url, context);
						}
					});
					await import(${JSON.stringify(launcherUrl)});
					`
				],
				{
					env: {
						...process.env,
						DATABASE_URL: 'postgres://test:test@127.0.0.1:1/recipe_test',
						LLM_BASE_URL: 'http://primary.invalid/v1',
						LLM_FALLBACK_BASE_URL: 'http://fallback.invalid/v1',
						LLM_API_KEY: 'inherited-key',
						LLM_MODEL: 'inherited-model',
						E2E_CHAT_STUB: chatStub ? '1' : ''
					},
					timeout: 10_000
				}
			);
			const appEnvironment = JSON.parse(stdout);
			expect(appEnvironment).toMatchObject({
				baseUrl: chatStub ? CHAT_STUB_BASE_URL : '',
				fallbackBaseUrl: ''
			});
			if (chatStub) {
				expect(appEnvironment).toMatchObject({
					apiKey: CHAT_STUB_API_KEY,
					model: CHAT_STUB_MODEL
				});
			}
		}
	);
});
