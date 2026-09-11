import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { AppError } from '../errors';
import { IMAGE_VARIANTS, renderImageVariants } from './image-pipeline';

/** A plain coloured rectangle is enough: only size and format are under test. */
function picture(
	width: number,
	height: number,
	format: 'jpeg' | 'png' | 'tiff' = 'jpeg'
): Promise<Buffer> {
	const image = sharp({
		create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } }
	});
	return (
		format === 'png' ? image.png() : format === 'tiff' ? image.tiff() : image.jpeg()
	).toBuffer();
}

async function failure(run: Promise<unknown>): Promise<AppError> {
	try {
		await run;
	} catch (err) {
		if (err instanceof AppError) return err;
		throw err;
	}
	throw new Error('expected a failure');
}

describe('renderImageVariants', () => {
	it('makes one WebP for every variant', async () => {
		const out = await renderImageVariants(await picture(800, 600));
		expect(Object.keys(out.variants).sort()).toEqual(Object.keys(IMAGE_VARIANTS).sort());
		for (const variant of Object.values(out.variants)) {
			expect(variant.mime).toBe('image/webp');
			expect((await sharp(variant.data).metadata()).format).toBe('webp');
		}
	});

	it('shrinks a large picture to the width of each variant', async () => {
		const out = await renderImageVariants(await picture(4000, 3000));
		expect(out.variants.detail.width).toBe(IMAGE_VARIANTS.detail.width);
		expect(out.variants.thumb.width).toBe(IMAGE_VARIANTS.thumb.width);
	});

	it('makes every variant smaller than the original', async () => {
		const original = await picture(4000, 3000, 'png');
		const out = await renderImageVariants(original);
		for (const variant of Object.values(out.variants))
			expect(variant.data.byteLength).toBeLessThan(original.byteLength);
	});

	it('does not enlarge a picture that is already small', async () => {
		const out = await renderImageVariants(await picture(200, 150));
		expect(out.variants.detail.width).toBe(200);
		expect(out.variants.thumb.width).toBe(200);
	});

	it('reports the size and the format of the original', async () => {
		const out = await renderImageVariants(await picture(800, 600, 'png'));
		expect(out.width).toBe(800);
		expect(out.height).toBe(600);
		expect(out.mime).toBe('image/png');
	});

	it('calls a JPEG image/jpeg and not image/jpg', async () => {
		const out = await renderImageVariants(await picture(80, 60));
		expect(out.mime).toBe('image/jpeg');
	});

	it('refuses bytes that are not a picture', async () => {
		const err = await failure(renderImageVariants(Buffer.from('this is not a picture at all')));
		expect(err.status).toBe(400);
		expect(err.message).toMatch(/could not be decoded/i);
	});

	it('refuses a format the app does not accept', async () => {
		const err = await failure(renderImageVariants(await picture(100, 100, 'tiff')));
		expect(err.status).toBe(400);
		expect(err.message).toMatch(/JPEG, PNG, WebP/i);
	});

	it('refuses a picture with too many pixels on a side', async () => {
		const err = await failure(renderImageVariants(await picture(10001, 2, 'png')));
		expect(err.status).toBe(400);
		expect(err.message).toMatch(/dimensions are too large/i);
	});
});
