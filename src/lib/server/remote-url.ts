import { AppError } from '$lib/server/errors';

/**
 * An absolute http(s) URL, or a 400 the user can act on.
 *
 * Shared by every outbound fetch the user starts — a recipe page, a picture —
 * so that "https:// only" is decided in one place. A bare `example.com/x` is
 * read as https; a relative address needs the page it came from as `base`.
 */
export function toHttpUrl(raw: string, base?: string): URL {
	const text = raw.trim();
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) || base ? text : `https://${text}`;
	let url: URL;
	try {
		url = new URL(withScheme, base);
	} catch {
		throw new AppError(400, 'That is not a web address. Paste a link that starts with https://');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		throw new AppError(400, 'That is not a web address. Paste a link that starts with https://');
	return url;
}
