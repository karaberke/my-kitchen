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

/**
 * Qualities to fall back to, in order.
 *
 * A picture that arrives already compressed — the usual case for one taken from
 * a link, where the site has optimised it — can come out *larger* at the quality
 * we prefer, because the variant is then a same-size re-encode. Storing that
 * would be the opposite of compressing it, so the encoder steps down and keeps
 * the smallest result. It stops as soon as the variant is no larger than the
 * source, so a picture that never needed the step down never pays for it.
 *
 * The floor is quality, not size: a source the site has already optimised hard
 * can stay marginally under the smallest variant we will make, and softening
 * every photo further to win those few percent is the worse trade.
 */
const FALLBACK_QUALITIES = [65, 50];

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

	const encode = (width: number, quality: number) =>
		sharp(buffer, { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION })
			.rotate()
			.resize({ width, withoutEnlargement: true })
			.webp({ quality })
			.toBuffer({ resolveWithObject: true });

	const variants = {} as Record<ImageVariant, RenderedVariant>;
	for (const [name, spec] of Object.entries(IMAGE_VARIANTS)) {
		let out = await encode(spec.width, spec.quality);
		for (const quality of FALLBACK_QUALITIES) {
			if (out.data.byteLength <= buffer.byteLength) break;
			const smaller = await encode(spec.width, quality);
			if (smaller.data.byteLength < out.data.byteLength) out = smaller;
		}
		variants[name as ImageVariant] = {
			data: out.data,
			width: out.info.width,
			height: out.info.height,
			bytes: out.data.byteLength,
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
