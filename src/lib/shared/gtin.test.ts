import { describe, expect, it } from 'vitest';
import {
	checkDigit,
	expandUpcE,
	identifyAs,
	identifyManual,
	providerGtin,
	symbologyFromLabel,
	toCanonicalGtin,
	type GtinResult
} from './gtin';

const good = (r: GtinResult) => {
	if (!r.ok) throw new Error(`expected a code, got ${r.reason}: ${r.message}`);
	return r.identity;
};
const bad = (r: GtinResult) => {
	if (r.ok) throw new Error(`expected a rejection, got ${r.identity.gtin}`);
	return r.reason;
};

describe('check digit', () => {
	it('computes the GS1 modulo-10 digit', () => {
		expect(checkDigit('01234567890')).toBe(5); // UPC-A
		expect(checkDigit('400638133393')).toBe(1); // EAN-13
		expect(checkDigit('9638507')).toBe(4); // EAN-8
	});
});

describe('identifyManual', () => {
	it('reads the three unambiguous lengths', () => {
		expect(good(identifyManual('012345678905')).symbology).toBe('upc_a');
		expect(good(identifyManual('4006381333931')).symbology).toBe('ean_13');
	});

	it('accepts the spaces and hyphens printed on a pack', () => {
		expect(good(identifyManual(' 0 12345 67890 5 ')).gtin).toBe('00012345678905');
		expect(good(identifyManual('4-006381-333931')).digits).toBe('4006381333931');
	});

	it('never reduces arbitrary text to its digits', () => {
		expect(bad(identifyManual('order 012345678905 please'))).toBe('not_a_code');
		expect(bad(identifyManual('https://example.test/012345678905'))).toBe('not_a_code');
		expect(bad(identifyManual('12345abc'))).toBe('not_a_code');
		expect(bad(identifyManual(''))).toBe('empty');
	});

	it('rejects a wrong check digit instead of repairing it', () => {
		expect(bad(identifyManual('012345678904'))).toBe('check_digit');
		expect(bad(identifyManual('4006381333930'))).toBe('check_digit');
	});

	it('rejects lengths that are not a retail product code', () => {
		expect(bad(identifyManual('12345'))).toBe('length');
		expect(bad(identifyManual('00012345678905'))).toBe('length');
	});

	it('refuses to guess between UPC-E and EAN-8', () => {
		// 01234565 carries a valid check digit under both readings, and the two
		// readings name different products.
		expect(bad(identifyManual('01234565'))).toBe('ambiguous_length');
		expect(good(identifyManual('01234565', 'upc_e')).gtin).toBe('00012345000065');
		expect(good(identifyManual('01234565', 'ean_8')).gtin).toBe('00000001234565');
	});
});

describe('canonical equality', () => {
	it('makes a UPC-A equal to the EAN-13 that carries its leading zero', () => {
		const upcA = good(identifyManual('012345678905'));
		const ean13 = good(identifyManual('0012345678905'));
		expect(upcA.gtin).toBe(ean13.gtin);
		expect(upcA.gtin).toBe('00012345678905');
		expect(upcA.digits).not.toBe(ean13.digits);
	});

	it('makes a UPC-E equal to the UPC-A it expands to', () => {
		const upcE = good(identifyAs('04512307', 'upc_e'));
		const upcA = good(identifyManual('045000001237'));
		expect(upcE.gtin).toBe(upcA.gtin);
		expect(upcE.digits).toBe('04512307');
		expect(upcE.expanded).toBe('045000001237');
	});

	it('pads to fourteen digits', () => {
		expect(toCanonicalGtin('96385074')).toBe('00000096385074');
	});
});

describe('expandUpcE', () => {
	it('expands every last-digit rule', () => {
		expect(expandUpcE('04512307')).toBe('045000001237'); // rule 0
		expect(expandUpcE('01234565')).toBe('012345000065'); // rule 5..9
	});

	it('refuses a number system UPC-E does not define', () => {
		expect(expandUpcE('96385074')).toBeNull();
		expect(expandUpcE('1234567')).toBeNull();
	});
});

describe('identifyAs', () => {
	it('holds the decoder to the length of the format it reported', () => {
		expect(bad(identifyAs('012345678905', 'ean_13'))).toBe('length');
		expect(bad(identifyAs('96385074', 'upc_e'))).toBe('check_digit');
		expect(good(identifyAs('96385074', 'ean_8')).gtin).toBe('00000096385074');
	});
});

describe('providerGtin', () => {
	it('pads what a provider reports so it can be compared', () => {
		expect(providerGtin('012345678905')).toBe('00012345678905');
		expect(providerGtin('0012345678905')).toBe('00012345678905');
		expect(providerGtin(' 00012345678905 ')).toBe('00012345678905');
	});

	it('returns null rather than repair a value that is not a GTIN', () => {
		expect(providerGtin('012345678904')).toBeNull();
		expect(providerGtin('Kirkland Signature')).toBeNull();
		expect(providerGtin('')).toBeNull();
		expect(providerGtin(null)).toBeNull();
		expect(providerGtin(undefined)).toBeNull();
	});
});

describe('symbologyFromLabel', () => {
	it('maps the four retail formats', () => {
		expect(symbologyFromLabel('EAN-13', '4006381333931')).toBe('ean_13');
		expect(symbologyFromLabel('EAN-8', '96385074')).toBe('ean_8');
		expect(symbologyFromLabel('UPC-A', '012345678905')).toBe('upc_a');
		expect(symbologyFromLabel('UPC-E', '04512307')).toBe('upc_e');
	});

	it('believes a decoder that already expanded a UPC-E', () => {
		expect(symbologyFromLabel('UPC-E', '045000001237')).toBe('upc_a');
	});

	it('sends everything else to manual entry', () => {
		expect(symbologyFromLabel('QR Code', 'https://example.test')).toBeNull();
		expect(symbologyFromLabel('DataBar Expanded', '0112345678901231')).toBeNull();
		expect(symbologyFromLabel('Code 128', 'ABC-123')).toBeNull();
	});
});
