import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const server = base.webServer;
if (!server || Array.isArray(server)) throw new Error('Chat tests require one guarded web server.');

export default defineConfig({
	...base,
	testIgnore: [],
	testMatch: '**/chat.spec.ts',
	webServer: {
		...server,
		env: { ...process.env, ...server.env, E2E_CHAT_STUB: '1' }
	}
});
