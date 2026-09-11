import sharp, { type Metadata } from 'sharp';
import { AppError } from '$lib/server/errors';

/**
 * Turning bytes into the pictures the app serves.
 *
 * Deliberately free of the database and of storage: bytes in, bytes out. Every
 * source of an image — an upload, a link — goes through here, so a picture is
 * decoded, checked and compressed the same way whatever brought it in.
 */

export const IMAGE_VARIANTS = {
	detail: { width: 1600, quality: 80 },
	thumb: { width: 480, quality: 74 }
} as const;
export type ImageVariant = keyof typeof IMAGE_VARIANTS;

const ALLOWED_INPUT = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif']);
const MAX_DIMENSION = 10000;

export interface RenderedVariant {
	/** The compressed bytes, ready to store. */
	data: Buffer;
	width: number;
	height: number;
	bytes: number;
	mime: string;
}

export interface RenderedImage {
	/** The type of the original, as decoded — never as the sender declared it. */
	mime: string;
	width: number;
	height: number;
	variants: Record<ImageVariant, RenderedVariant>;
}

/**
 * Validate bytes (real decoded format + dimensions), then compress bounded
 * WebP variants and strip metadata. The original is never stored.
 */
export async function renderImageVariants(buffer: Buffer): Promise<RenderedImage> {
	let meta: Metadata;
	try {
		meta = await sharp(buffer, { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION }).metadata();
	} catch {
		throw new AppError(400, 'That file could not be decoded as an image');
	}
	if (!meta.format || !ALLOWED_INPUT.has(meta.format) || !meta.width || !meta.height)
		throw new AppError(400, 'Use a JPEG, PNG, WebP, AVIF or GIF image');
	if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION)
		throw new AppError(400, 'Image dimensions are too large');

	const variants = {} as Record<ImageVariant, RenderedVariant>;
	for (const [name, spec] of Object.entries(IMAGE_VARIANTS)) {
		const out = await sharp(buffer, { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION })
			.rotate()
			.resize({ width: spec.width, withoutEnlargement: true })
			.webp({ quality: spec.quality })
			.toBuffer({ resolveWithObject: true });
		variants[name as ImageVariant] = {
			data: out.data,
			width: out.info.width,
			height: out.info.height,
			bytes: out.info.size,
			mime: 'image/webp'
		};
	}
	return {
		mime: meta.format === 'jpeg' ? 'image/jpeg' : `image/${meta.format}`,
		width: meta.width,
		height: meta.height,
		variants
	};
}
