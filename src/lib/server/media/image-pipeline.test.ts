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

/**
 * Photo-like bytes: smooth gradients plus mild grain, already saved as JPEG.
 * A flat rectangle compresses unrealistically well and hides the case where a
 * re-encode makes a picture larger. Deterministic: the seed is fixed.
 */
function photo(size: number, jpegQuality: number): Promise<Buffer> {
	const pixels = Buffer.alloc(size * size * 3);
	let seed = 7;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			const grain = ((seed >> 16) & 0x1f) - 16;
			const i = (y * size + x) * 3;
			const set = (offset: number, value: number) =>
				(pixels[i + offset] = Math.max(0, Math.min(255, Math.round(value + grain))));
			set(0, (x / size) * 200 + 30);
			set(1, (y / size) * 180 + 40);
			set(2, ((x + y) / (2 * size)) * 160 + 50);
		}
	}
	return sharp(pixels, { raw: { width: size, height: size, channels: 3 } })
		.jpeg({ quality: jpegQuality })
		.toBuffer();
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

	it('steps the quality down rather than store a bigger picture', async () => {
		// A photo saved as a small JPEG re-encodes to a *larger* WebP at the quality
		// we prefer, because the variant is then a same-size re-encode. The encoder
		// must not simply keep that result.
		const original = await photo(1024, 50);
		const preferred = await sharp(original)
			.rotate()
			.resize({ width: IMAGE_VARIANTS.detail.width, withoutEnlargement: true })
			.webp({ quality: IMAGE_VARIANTS.detail.quality })
			.toBuffer();
		expect(preferred.byteLength).toBeGreaterThan(original.byteLength); // the case is real

		const out = await renderImageVariants(original);
		expect(out.variants.detail.data.byteLength).toBeLessThan(preferred.byteLength);
		// This source is one the ladder can get under. A source the site has
		// optimised harder may stop above it: the floor is quality, not size.
		expect(out.variants.detail.data.byteLength).toBeLessThanOrEqual(original.byteLength);
	}, 30000);

	it('keeps the best quality when that already compresses the picture', async () => {
		// The step down must not cost quality on a picture that never needed it.
		const original = await picture(2000, 1500, 'png');
		const plain = await sharp(original)
			.rotate()
			.resize({ width: IMAGE_VARIANTS.detail.width, withoutEnlargement: true })
			.webp({ quality: IMAGE_VARIANTS.detail.quality })
			.toBuffer();
		const out = await renderImageVariants(original);
		expect(out.variants.detail.data.byteLength).toBe(plain.byteLength);
	}, 30000);

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
