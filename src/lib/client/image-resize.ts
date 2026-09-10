/**
 * Shrink a chosen photo in the browser before it is uploaded.
 *
 * A phone photo is typically 3–5 MB and far larger than the 1600px the server
 * keeps, so sending the original wastes the upload and then makes sharp decode a
 * huge image. Downscaling here cuts both.
 *
 * This is an optimisation, never a guarantee: the server still re-decodes,
 * re-encodes and validates whatever arrives, because a browser can send anything.
 * Every failure path therefore falls back to the original file rather than
 * blocking the upload.
 */

/** Matches IMAGE_VARIANTS.detail on the server — anything larger is thrown away there anyway. */
export const MAX_UPLOAD_EDGE = 1600;
/** Below this, re-encoding usually costs more bytes than it saves. */
export const RESIZE_MIN_BYTES = 512 * 1024;
const WEBP_QUALITY = 0.82;

/** Longest-edge fit, never enlarging. Exported for tests. */
export function targetSize(
	width: number,
	height: number,
	maxEdge = MAX_UPLOAD_EDGE
): { width: number; height: number } {
	const longest = Math.max(width, height);
	if (longest <= maxEdge || longest === 0) return { width, height };
	const scale = maxEdge / longest;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}

/** Worth re-encoding only when it is big enough to matter and actually an image. */
export function shouldResize(file: File, minBytes = RESIZE_MIN_BYTES): boolean {
	if (!file.type.startsWith('image/')) return false;
	// An animated GIF would lose its animation, and SVG has no raster to resize.
	if (file.type === 'image/gif' || file.type === 'image/svg+xml') return false;
	return file.size > minBytes;
}

function canResize(): boolean {
	return (
		typeof createImageBitmap === 'function' &&
		typeof document !== 'undefined' &&
		typeof HTMLCanvasElement !== 'undefined'
	);
}

/**
 * Returns a smaller WebP File, or the original when resizing is unnecessary,
 * unsupported, or would not actually save bytes.
 */
export async function resizeForUpload(file: File, maxEdge = MAX_UPLOAD_EDGE): Promise<File> {
	if (!shouldResize(file) || !canResize()) return file;

	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return file; // not decodable here; let the server judge it
	}
	try {
		const { width, height } = targetSize(bitmap.width, bitmap.height, maxEdge);
		if (width === bitmap.width && height === bitmap.height && file.type === 'image/webp')
			return file;

		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return file;
		ctx.drawImage(bitmap, 0, 0, width, height);

		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY)
		);
		// A browser without WebP encoding returns null, or a PNG larger than the source.
		if (!blob || blob.size >= file.size) return file;

		const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
		return new File([blob], `${name}.webp`, { type: 'image/webp', lastModified: Date.now() });
	} catch {
		return file;
	} finally {
		bitmap.close();
	}
}
