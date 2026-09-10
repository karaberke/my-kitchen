import { describe, expect, it } from 'vitest';
import { shouldResize, targetSize, MAX_UPLOAD_EDGE } from './image-resize';

function fileOf(type: string, size: number): File {
	const file = new File([new Uint8Array(1)], 'photo', { type });
	// File.size is read-only; stub it so a large pick can be modelled without allocating one.
	Object.defineProperty(file, 'size', { value: size });
	return file;
}

describe('targetSize', () => {
	it('fits the longest edge and keeps the aspect ratio', () => {
		expect(targetSize(4032, 3024)).toEqual({ width: 1600, height: 1200 });
		expect(targetSize(3024, 4032)).toEqual({ width: 1200, height: 1600 });
	});

	it('never enlarges a smaller photo', () => {
		expect(targetSize(800, 600)).toEqual({ width: 800, height: 600 });
		expect(targetSize(MAX_UPLOAD_EDGE, 900)).toEqual({ width: MAX_UPLOAD_EDGE, height: 900 });
	});

	it('keeps an extreme panorama at least one pixel tall', () => {
		expect(targetSize(20000, 5).height).toBe(1);
	});

	it('does not divide by zero on an empty bitmap', () => {
		expect(targetSize(0, 0)).toEqual({ width: 0, height: 0 });
	});
});

describe('shouldResize', () => {
	it('resizes a large photo', () => {
		expect(shouldResize(fileOf('image/jpeg', 4_000_000))).toBe(true);
	});

	it('leaves small files alone', () => {
		expect(shouldResize(fileOf('image/jpeg', 100_000))).toBe(false);
	});

	it('never touches a GIF or SVG, which would lose animation or have no raster', () => {
		expect(shouldResize(fileOf('image/gif', 4_000_000))).toBe(false);
		expect(shouldResize(fileOf('image/svg+xml', 4_000_000))).toBe(false);
	});

	it('ignores anything that is not an image', () => {
		expect(shouldResize(fileOf('application/pdf', 4_000_000))).toBe(false);
	});
});
