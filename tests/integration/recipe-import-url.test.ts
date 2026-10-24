import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { recipeAttachments } from '$lib/server/db/schema';
import { loadReadableAttachment } from '$lib/server/media/attachments';
import { importRecipe } from '$lib/server/recipe-import';
import { createUser, resetDb } from './helpers';

const RECIPE_PAGE = `<html><head><script type="application/ld+json">${JSON.stringify({
	'@context': 'https://schema.org',
	'@type': 'Recipe',
	name: 'Bounded compressed chicken',
	recipeYield: '4 servings',
	recipeIngredient: ['200 g chicken breast'],
	recipeInstructions: ['Bake carefully.']
})}</script></head><body>Recipe.</body></html>`;

const importOptions = { titleOverride: '', forced: false, clientParsed: null };

beforeEach(resetDb);

function pageBytes(size: number) {
	const padding = size - Buffer.byteLength(RECIPE_PAGE) - '<!---->'.length;
	return Buffer.from(`${RECIPE_PAGE}<!--${' '.repeat(padding)}-->`);
}

/** Real encoded HTTP responses exercise the download cap after decompression. */
async function serveCompressedPage(bytes: Buffer, chunked = false) {
	const compressed = brotliCompressSync(bytes);
	const server = createServer((_req, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.setHeader('content-encoding', 'br');
		if (chunked) {
			const middle = Math.floor(compressed.byteLength / 2);
			res.write(compressed.subarray(0, middle));
			res.end(compressed.subarray(middle));
		} else {
			res.setHeader('content-length', compressed.byteLength);
			res.end(compressed);
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/recipe`,
		compressedSize: compressed.byteLength,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
}

describe('bounded HTML recipe imports', () => {
	it('parses and keeps a Brotli URL page larger than 2 MB after decompression', async () => {
		const alice = await createUser('Alice');
		const bytes = pageBytes(2_315_586);
		const fixture = await serveCompressedPage(bytes);
		try {
			expect(fixture.compressedSize).toBeLessThan(2_000_000);
			const result = await importRecipe(alice.id, {
				...importOptions,
				kind: 'link',
				url: fixture.url
			});
			expect(result.input.title).toBe('Bounded compressed chicken');
			expect(result.input.ingredients).toMatchObject([{ name: 'chicken breast', amount: '200' }]);
			expect(result.input.steps).toMatchObject([{ text: 'Bake carefully.' }]);
			expect(result.url).toBe(fixture.url);
			expect(await loadReadableAttachment(db, alice.id, result.attachmentId)).toMatchObject({
				mime: 'text/html',
				sizeBytes: bytes.byteLength
			});
		} finally {
			await fixture.close();
		}
	});

	it('rejects a chunked Brotli URL page larger than 5 MB after decompression', async () => {
		const alice = await createUser('Alice');
		const fixture = await serveCompressedPage(pageBytes(5_000_001), true);
		try {
			expect(fixture.compressedSize).toBeLessThan(2_000_000);
			await expect(
				importRecipe(alice.id, { ...importOptions, kind: 'link', url: fixture.url })
			).rejects.toMatchObject({ status: 413, message: 'That page is larger than 5 MB.' });
			expect(await db.select().from(recipeAttachments)).toHaveLength(0);
		} finally {
			await fixture.close();
		}
	});

	it('limits pasted HTML by UTF-8 bytes even when its character count is below 2 MB', async () => {
		const alice = await createUser('Alice');
		const html = `${RECIPE_PAGE}<!--${'界'.repeat(1_700_000)}-->`;
		expect(html.length).toBeLessThan(2_000_000);
		expect(Buffer.byteLength(html, 'utf8')).toBeGreaterThan(5_000_000);
		await expect(
			importRecipe(alice.id, { ...importOptions, kind: 'pasted', html })
		).rejects.toMatchObject({ status: 413, message: 'That page is larger than 5 MB.' });
		expect(await db.select().from(recipeAttachments)).toHaveLength(0);
	});
});
