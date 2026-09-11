import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '$lib/server/db';
import { images } from '$lib/server/db/schema';
import { AppError } from '$lib/server/errors';
import { storeRecipeImageFromUrl, variantKey } from '$lib/server/media/images';
import { storage } from '$lib/server/media/storage';
import { createUser, resetDb, type TestUser } from './helpers';

/**
 * A picture reached over the network, end to end: download, decode, compress,
 * store, record. The server is on loopback, which the fetch is allowed to reach
 * by the same decision that governs recipe-page import.
 */

let server: Server;
let origin: string;
let user: TestUser;
let original: Buffer;
/** What the next request is answered with. */
let reply: { status: number; type: string; body: Buffer };

beforeAll(async () => {
	await resetDb();
	user = await createUser('Imogen');
	original = await sharp({
		create: { width: 2400, height: 1600, channels: 3, background: { r: 30, g: 90, b: 60 } }
	})
		.png()
		.toBuffer();
	reply = { status: 200, type: 'image/png', body: original };
	server = createServer((req, res) => {
		res.writeHead(reply.status, { 'content-type': reply.type });
		res.end(reply.body);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function storedBytes(objectKey: string, variant: 'thumb' | 'detail'): Promise<Buffer> {
	const object = await storage().get(variantKey(objectKey, variant));
	if (!object) throw new Error(`nothing stored for ${variant}`);
	const chunks: Uint8Array[] = [];
	for await (const chunk of object.stream as unknown as AsyncIterable<Uint8Array>)
		chunks.push(chunk);
	return Buffer.concat(chunks);
}

describe('storeRecipeImageFromUrl', () => {
	it('records the picture it downloaded', async () => {
		reply = { status: 200, type: 'image/png', body: original };
		const imageId = await storeRecipeImageFromUrl(user.id, `${origin}/dal.png`);
		const [row] = await db.select().from(images).where(eq(images.id, imageId));
		expect(row.ownerUserId).toBe(user.id);
		expect(row.mime).toBe('image/png');
		expect(row.width).toBe(2400);
		expect(row.height).toBe(1600);
	});

	it('compresses it into WebP variants instead of keeping the original', async () => {
		reply = { status: 200, type: 'image/png', body: original };
		const imageId = await storeRecipeImageFromUrl(user.id, `${origin}/dal.png`);
		const [row] = await db.select().from(images).where(eq(images.id, imageId));

		for (const variant of ['thumb', 'detail'] as const) {
			const bytes = await storedBytes(row.objectKey, variant);
			expect((await sharp(bytes).metadata()).format).toBe('webp');
			expect(bytes.byteLength).toBeLessThan(original.byteLength);
		}
		expect((await sharp(await storedBytes(row.objectKey, 'detail')).metadata()).width).toBe(1600);
		expect((await sharp(await storedBytes(row.objectKey, 'thumb')).metadata()).width).toBe(480);
	});

	it('refuses a link that answers with a page', async () => {
		reply = { status: 200, type: 'text/html', body: Buffer.from('<html></html>') };
		await expect(storeRecipeImageFromUrl(user.id, `${origin}/dal`)).rejects.toBeInstanceOf(
			AppError
		);
	});

	it('refuses a link that answers with bytes that are not a picture', async () => {
		reply = { status: 200, type: 'image/png', body: Buffer.from('not a picture at all, really') };
		await expect(storeRecipeImageFromUrl(user.id, `${origin}/dal.png`)).rejects.toThrow(
			/could not be decoded/i
		);
	});

	it('refuses a link the site does not serve', async () => {
		reply = { status: 404, type: 'text/plain', body: Buffer.from('gone') };
		await expect(storeRecipeImageFromUrl(user.id, `${origin}/missing.png`)).rejects.toThrow(
			/could not find/i
		);
	});
});
