/**
 * Barcode identity.
 *
 * Four retail symbologies are supported: UPC-A, UPC-E, EAN-13 and EAN-8.
 * Equality is decided on a 14-digit canonical GTIN, never on the printed
 * string, so "0012345678905" and "012345678905" are the same product and a
 * UPC-E equals the UPC-A it expands to.
 *
 * Nothing here guesses. Input is rejected unless it is already a code: digits,
 * optionally separated by the spaces and hyphens printed on a pack. Arbitrary
 * text is never reduced to its digits, and eight digits alone are ambiguous
 * because UPC-E and EAN-8 share that length and mean different things.
 */

export type Symbology = 'upc_a' | 'upc_e' | 'ean_13' | 'ean_8';

export const SYMBOLOGIES: readonly Symbology[] = ['upc_a', 'upc_e', 'ean_13', 'ean_8'];

export interface BarcodeIdentity {
	/** What the decoder or the person supplied, with outer whitespace removed. */
	raw: string;
	symbology: Symbology;
	/** The digits as printed for that symbology. A UPC-E stays eight digits. */
	digits: string;
	/** Twelve digits for a UPC-E, equal to `digits` for every other symbology. */
	expanded: string;
	/** The 14-digit equality key. */
	gtin: string;
}

export type GtinFailure =
	'empty' | 'not_a_code' | 'length' | 'check_digit' | 'ambiguous_length' | 'unsupported_symbology';

export type GtinResult =
	| { ok: true; identity: BarcodeIdentity }
	| { ok: false; reason: GtinFailure; message: string; digits?: string };

const MESSAGES: Record<GtinFailure, string> = {
	empty: 'Enter the number printed under the barcode.',
	not_a_code: 'A barcode number holds digits only.',
	length: 'A barcode number has 8, 12 or 13 digits.',
	check_digit: 'That number fails its check digit. Read it again, or add the item by hand.',
	ambiguous_length: 'Eight digits can be UPC-E or EAN-8. Say which one it is.',
	unsupported_symbology: 'That barcode is not a retail product code.'
};

function fail(reason: GtinFailure, digits?: string): GtinResult {
	return { ok: false, reason, message: MESSAGES[reason], digits };
}

/**
 * Keep the digits of an input that is already a code.
 *
 * Spaces and hyphens are removed because packs print them between the digit
 * groups. One other character rejects the whole input.
 */
function digitsOf(raw: string): string | null {
	const trimmed = raw.trim();
	if (!/^[0-9][0-9 -]*$/.test(trimmed)) return null;
	return trimmed.replace(/[ -]/g, '');
}

/** GS1 modulo-10 check digit for a body that does not include the check digit. */
export function checkDigit(body: string): number {
	let sum = 0;
	// The weight is 3 for the rightmost body digit and alternates leftwards.
	for (let i = 0; i < body.length; i++) {
		const weight = (body.length - 1 - i) % 2 === 0 ? 3 : 1;
		sum += Number(body[i]) * weight;
	}
	return (10 - (sum % 10)) % 10;
}

function checkDigitIsValid(code: string): boolean {
	return checkDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

/**
 * Expand a UPC-E to its UPC-A.
 *
 * The expansion is decided by the last payload digit, and the check digit of
 * the UPC-A is recomputed rather than carried over. Returns null when the
 * number system is not 0 or 1, which UPC-E does not define.
 */
export function expandUpcE(eight: string): string | null {
	if (!/^[0-9]{8}$/.test(eight)) return null;
	const system = eight[0];
	if (system !== '0' && system !== '1') return null;
	const [x1, x2, x3, x4, x5, x6] = eight.slice(1, 7);
	let manufacturer: string;
	let item: string;
	switch (x6) {
		case '0':
		case '1':
		case '2':
			manufacturer = `${x1}${x2}${x6}00`;
			item = `00${x3}${x4}${x5}`;
			break;
		case '3':
			manufacturer = `${x1}${x2}${x3}00`;
			item = `000${x4}${x5}`;
			break;
		case '4':
			manufacturer = `${x1}${x2}${x3}${x4}0`;
			item = `0000${x5}`;
			break;
		default:
			manufacturer = `${x1}${x2}${x3}${x4}${x5}`;
			item = `0000${x6}`;
			break;
	}
	const body = `${system}${manufacturer}${item}`;
	return `${body}${checkDigit(body)}`;
}

/** Pad a validated code to the 14 digits used for equality. */
export function toCanonicalGtin(code: string): string {
	return code.padStart(14, '0');
}

function identity(raw: string, symbology: Symbology, digits: string, expanded: string): GtinResult {
	return {
		ok: true,
		identity: { raw: raw.trim(), symbology, digits, expanded, gtin: toCanonicalGtin(expanded) }
	};
}

/**
 * Validate digits that are already known to be in one symbology. This is the
 * path a decoder takes: the decoder reports the format it read.
 */
export function identifyAs(raw: string, symbology: Symbology): GtinResult {
	const digits = digitsOf(raw);
	if (digits === null) return fail(raw.trim() === '' ? 'empty' : 'not_a_code');

	const expectedLength = symbology === 'ean_13' ? 13 : symbology === 'upc_a' ? 12 : 8;
	if (digits.length !== expectedLength) return fail('length', digits);

	if (symbology === 'upc_e') {
		const expanded = expandUpcE(digits);
		// The eighth digit checks the UPC-A, so an invalid number system and a
		// wrong check digit are the same answer to the user.
		if (!expanded || expanded[11] !== digits[7]) return fail('check_digit', digits);
		return identity(raw, 'upc_e', digits, expanded);
	}

	if (!checkDigitIsValid(digits)) return fail('check_digit', digits);
	return identity(raw, symbology, digits, digits);
}

/**
 * Read a number a person typed. Length decides the symbology, except at eight
 * digits, where the caller must resolve UPC-E against EAN-8 explicitly.
 */
export function identifyManual(raw: string, eightDigitHint?: 'upc_e' | 'ean_8'): GtinResult {
	const digits = digitsOf(raw);
	if (digits === null) return fail(raw.trim() === '' ? 'empty' : 'not_a_code');
	if (digits.length === 13) return identifyAs(digits, 'ean_13');
	if (digits.length === 12) return identifyAs(digits, 'upc_a');
	if (digits.length === 8) {
		if (!eightDigitHint) return fail('ambiguous_length', digits);
		return identifyAs(digits, eightDigitHint);
	}
	return fail('length', digits);
}

/**
 * Map a decoder's format label to a symbology.
 *
 * The labels are the human-readable names the retail symbologies are known by,
 * so this is not tied to one decoder. Anything else — a QR code, a DataBar, a
 * retailer's own label — returns null and goes to manual entry, because those
 * payloads are not globally unique product numbers and must never be followed
 * or treated as one.
 *
 * A decoder that already expanded a UPC-E to twelve digits is reported as what
 * it handed over, so the check digit is validated against the right reading.
 */
export function symbologyFromLabel(label: string, digits: string): Symbology | null {
	switch (label.trim().toUpperCase()) {
		case 'EAN-13':
		case 'EAN13':
			return 'ean_13';
		case 'EAN-8':
		case 'EAN8':
			return 'ean_8';
		case 'UPC-A':
		case 'UPCA':
			return 'upc_a';
		case 'UPC-E':
		case 'UPCE':
			return digits.replace(/[ -]/g, '').length === 12 ? 'upc_a' : 'upc_e';
		default:
			return null;
	}
}

/**
 * The canonical form of a GTIN a provider reported.
 *
 * Providers print the same product as 12, 13 or 14 digits, with or without
 * leading zeros, and sometimes with surrounding spaces. The value is only used
 * to confirm that the record we received is the record we asked for, so it is
 * padded but never repaired: a check digit that does not hold returns null.
 */
export function providerGtin(value: string | number | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const digits = digitsOf(String(value));
	if (digits === null) return null;
	if (digits.length < 8 || digits.length > 14) return null;
	if (!checkDigitIsValid(digits)) return null;
	return toCanonicalGtin(digits);
}
