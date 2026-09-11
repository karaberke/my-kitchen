/**
 * The on-device decoder.
 *
 * Nothing here is loaded until the scanner is opened: the module and its
 * WebAssembly file are fetched by the first call to `loadDecoder`. The file is
 * served from this origin, with the same hashed immutable URL as every other
 * build asset, so the app never depends on a CDN being reachable — which also
 * matters because the app is meant to run on a home network.
 */

import { symbologyFromLabel, type Symbology } from '$lib/shared/gtin';

/** Version-matched to the installed zxing-wasm by the bundler, not by hand. */
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export interface DecodedCode {
	/** What the decoder read, unchanged. */
	raw: string;
	symbology: Symbology;
}

/** The four retail formats. Nothing else is even looked for. */
const FORMATS = ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E'] as const;

type ReadBarcodes = typeof import('zxing-wasm/reader').readBarcodes;

let loading: Promise<ReadBarcodes> | null = null;

export function loadDecoder(): Promise<ReadBarcodes> {
	loading ??= (async () => {
		const reader = await import('zxing-wasm/reader');
		// Without this the library fetches its WebAssembly from jsDelivr.
		reader.prepareZXingModule({
			overrides: { locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path) },
			fireImmediately: true
		});
		return reader.readBarcodes;
	})();
	return loading;
}

/**
 * Read one frame. Returns null when the frame holds nothing this app accepts,
 * including a QR code or a retailer's own label.
 */
export async function decodeFrame(image: ImageData): Promise<DecodedCode | null> {
	const readBarcodes = await loadDecoder();
	const results = await readBarcodes(image, {
		formats: [...FORMATS],
		// One product at a time, and the fast path: a shopper holds the phone
		// square to the pack, and a slow frame is worse than a missed one.
		maxNumberOfSymbols: 1,
		tryHarder: false,
		tryRotate: true,
		tryInvert: false
	});
	for (const result of results) {
		if (!result.isValid || !result.text) continue;
		const symbology = symbologyFromLabel(result.format, result.text);
		if (symbology) return { raw: result.text, symbology };
	}
	return null;
}

/** Forget the loaded module. Used by tests only. */
export function resetDecoder(): void {
	loading = null;
}
