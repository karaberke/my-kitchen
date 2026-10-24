import { fetch as proxyFetch, ProxyAgent } from 'undici';
import { serverEnv } from '$lib/server/env';
import { AppError } from '$lib/server/errors';
import type { FetchImpl } from '$lib/server/fetch-capped';

/** An owned transport lasts until the caller has buffered or discarded every response. */
export interface ImportTransport {
	fetch: FetchImpl;
	browserFetch: FetchImpl;
	destroy(): Promise<void>;
}

/** Only URL imports use this dispatcher; trusted integrations keep their own connections. */
export function createImportTransport(timeoutMs: number, proxyUrl?: string): ImportTransport {
	let agent: ProxyAgent | undefined;
	let browserFetch: Promise<FetchImpl> | undefined;
	let closed = false;
	const abort = new AbortController();
	const proxy = () => {
		if (closed) throw new AppError(502, 'The download has ended. Try again.');
		const url = proxyUrl ?? serverEnv().IMPORT_PROXY_URL;
		if (!url)
			throw new AppError(
				503,
				'URL imports are unavailable. Upload a saved page or picture instead.'
			);
		return url;
	};
	return {
		async fetch(url, init) {
			agent ??= new ProxyAgent({ uri: proxy(), connections: 1, pipelining: 1 });
			const response = await proxyFetch(url, {
				method: 'GET',
				redirect: 'manual',
				headers: Object.fromEntries(new Headers(init.headers)),
				signal: init.signal,
				dispatcher: agent
			});
			return new Response(response.body as ReadableStream<Uint8Array> | null, {
				status: response.status,
				statusText: response.statusText,
				headers: Object.fromEntries(response.headers)
			});
		},
		async browserFetch(url, init) {
			browserFetch ??= createBrowserFetch(timeoutMs, proxy(), abort.signal);
			return (await browserFetch)(url, init);
		},
		async destroy() {
			if (closed) return;
			closed = true;
			abort.abort();
			browserFetch = undefined;
			await agent?.destroy();
		}
	};
}

/**
 * Impit has its own response class. Adapt its stream so the shared redirect,
 * timeout and byte-cap handling stays authoritative for both transports.
 */
async function createBrowserFetch(
	timeoutMs: number,
	proxyUrl: string,
	scopeSignal: AbortSignal
): Promise<FetchImpl> {
	const { Impit, TimeoutError } = await import('impit');
	// A client belongs to this import only; no cookies or user state are shared.
	const client = new Impit({
		browser: 'chrome',
		proxyUrl,
		http3: false,
		followRedirects: false,
		ignoreTlsErrors: false,
		timeout: timeoutMs
	});

	return async (url, init) => {
		const abort = new AbortController();
		const signal = AbortSignal.any([
			scopeSignal,
			abort.signal,
			...(init.signal ? [init.signal] : [])
		]);
		const normalizeError = (err: unknown): unknown => {
			if (signal.aborted) return signal.reason;
			return err instanceof TimeoutError ? new DOMException('Timed out', 'TimeoutError') : err;
		};
		const headers = new Headers(init.headers);
		// Overriding this would undo part of the Chrome impersonation.
		headers.delete('user-agent');
		let onAbort = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(signal.reason);
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
		const pending = client.fetch(url, {
			method: 'GET',
			redirect: 'manual',
			headers,
			signal,
			// Native connection setup also needs a timeout before a body exists.
			timeout: timeoutMs
		});
		let response: Awaited<typeof pending>;
		try {
			response = await Promise.race([pending, aborted]);
		} catch (err) {
			const reason = normalizeError(err);
			abort.abort(reason);
			// If native connection setup outlives the signal, discard its later answer.
			void pending.then((late) => late.body.cancel()).catch(() => {});
			throw reason;
		} finally {
			signal.removeEventListener('abort', onAbort);
		}

		const reader = response.body.getReader();
		const responseInit = {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		};
		// The standard Response constructor forbids bodies on these statuses.
		if ([204, 205, 304].includes(response.status)) {
			abort.abort();
			await reader.cancel().catch(() => {});
			return new Response(null, responseInit);
		}

		let finished = false;
		const finish = () => {
			finished = true;
			signal.removeEventListener('abort', onAbort);
		};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				onAbort = () => {
					finish();
					controller.error(normalizeError(signal.reason));
					void reader.cancel(signal.reason).catch(() => {});
				};
				signal.addEventListener('abort', onAbort, { once: true });
				if (signal.aborted) onAbort();
			},
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (finished) return;
					if (done) {
						finish();
						controller.close();
					} else controller.enqueue(value);
				} catch (err) {
					if (finished) return;
					const reason = normalizeError(err);
					finish();
					controller.error(reason);
					abort.abort(reason);
					void reader.cancel(reason).catch(() => {});
				}
			},
			async cancel(reason) {
				finish();
				// Abort first: cancelling a native reader alone can leave a stalled read open.
				abort.abort(reason);
				await reader.cancel(reason).catch(() => {});
			}
		});
		return new Response(body, responseInit);
	};
}
