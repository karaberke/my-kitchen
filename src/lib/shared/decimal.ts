/**
 * Fixed-point decimal with six fractional digits, backed by BigInt.
 *
 * All quantity arithmetic in the app (recipes, pantry, grocery planning) goes
 * through this type so that values survive the database -> JSON -> browser
 * round trip without binary floating point drift. PostgreSQL columns are
 * numeric(14,6); `toDb()` emits exactly that scale.
 */
const SCALE = 6;
const ONE = 10n ** BigInt(SCALE);
const MAX_ABS = 10n ** 14n; // matches numeric(14,6) precision

function divRound(n: bigint, d: bigint): bigint {
	if (d === 0n) throw new RangeError('Division by zero');
	if (d < 0n) {
		n = -n;
		d = -d;
	}
	const q = n / d;
	const r = n % d;
	const absR = r < 0n ? -r : r;
	if (absR * 2n >= d) return n < 0n ? q - 1n : q + 1n;
	return q;
}

function parseString(input: string): bigint {
	const s = input.trim();
	const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
	if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
		throw new TypeError(`Invalid decimal: ${JSON.stringify(input)}`);
	}
	const sign = m[1] === '-' ? -1n : 1n;
	const intPart = BigInt(m[2] || '0');
	const fracRaw = m[3] ?? '';
	let frac: bigint;
	if (fracRaw.length <= SCALE) {
		frac = BigInt(fracRaw + '0'.repeat(SCALE - fracRaw.length) || '0');
	} else {
		const kept = BigInt(fracRaw.slice(0, SCALE));
		const next = Number(fracRaw[SCALE]);
		frac = next >= 5 ? kept + 1n : kept;
	}
	const value = sign * (intPart * ONE + frac);
	if (value > MAX_ABS || value < -MAX_ABS) throw new RangeError('Decimal out of range');
	return value;
}

export class Dec {
	static readonly zero = new Dec(0n);
	static readonly one = new Dec(ONE);

	private constructor(private readonly units: bigint) {}

	static from(value: Dec | string | number | bigint): Dec {
		if (value instanceof Dec) return value;
		if (typeof value === 'bigint') return new Dec(value * ONE);
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) throw new TypeError('Decimal from non-finite number');
			return new Dec(parseString(value.toFixed(10)));
		}
		return new Dec(parseString(value));
	}

	/** Parse a value that may be null/undefined (e.g. nullable DB column). */
	static fromNullable(value: Dec | string | number | null | undefined): Dec | null {
		if (value === null || value === undefined || value === '') return null;
		return Dec.from(value);
	}

	static sum(values: Iterable<Dec>): Dec {
		let acc = 0n;
		for (const v of values) acc += v.units;
		return new Dec(acc);
	}

	static max(a: Dec, b: Dec): Dec {
		return a.units >= b.units ? a : b;
	}

	static min(a: Dec, b: Dec): Dec {
		return a.units <= b.units ? a : b;
	}

	add(other: Dec): Dec {
		return new Dec(this.units + other.units);
	}

	sub(other: Dec): Dec {
		return new Dec(this.units - other.units);
	}

	neg(): Dec {
		return new Dec(-this.units);
	}

	abs(): Dec {
		return this.units < 0n ? this.neg() : this;
	}

	mul(other: Dec): Dec {
		return new Dec(divRound(this.units * other.units, ONE));
	}

	/** this * num / den with a single rounding step. */
	mulRatio(num: number | bigint, den: number | bigint): Dec {
		return new Dec(divRound(this.units * BigInt(num), BigInt(den)));
	}

	/** this * num / den for decimal factors with a single rounding step. */
	mulDiv(num: Dec, den: Dec): Dec {
		return new Dec(divRound(this.units * num.units, den.units));
	}

	div(other: Dec): Dec {
		return new Dec(divRound(this.units * ONE, other.units));
	}

	cmp(other: Dec): -1 | 0 | 1 {
		return this.units < other.units ? -1 : this.units > other.units ? 1 : 0;
	}

	eq(other: Dec): boolean {
		return this.units === other.units;
	}
	gt(other: Dec): boolean {
		return this.units > other.units;
	}
	gte(other: Dec): boolean {
		return this.units >= other.units;
	}
	lt(other: Dec): boolean {
		return this.units < other.units;
	}
	lte(other: Dec): boolean {
		return this.units <= other.units;
	}
	isZero(): boolean {
		return this.units === 0n;
	}
	isNegative(): boolean {
		return this.units < 0n;
	}
	isPositive(): boolean {
		return this.units > 0n;
	}

	/** Canonical string: no exponent, trailing zeros trimmed, "-0" normalised. */
	toString(): string {
		return (
			this.toFixed(SCALE)
				.replace(/\.?0+$/, '')
				.replace(/^-0$/, '0') || '0'
		);
	}

	toJSON(): string {
		return this.toString();
	}

	/** Fixed scale string for numeric(14,6) columns. */
	toDb(): string {
		return this.toFixed(SCALE);
	}

	/** Fixed decimals for display, rounding half away from zero. */
	toFixed(decimals: number): string {
		if (decimals < 0 || decimals > SCALE) throw new RangeError('decimals must be 0..6');
		const factor = 10n ** BigInt(SCALE - decimals);
		const rounded = divRound(this.units, factor);
		const negative = rounded < 0n;
		const abs = negative ? -rounded : rounded;
		const scale = 10n ** BigInt(decimals);
		const intPart = abs / scale;
		const fracPart = abs % scale;
		const frac = decimals === 0 ? '' : '.' + fracPart.toString().padStart(decimals, '0');
		const text = `${intPart}${frac}`;
		return negative && abs !== 0n ? `-${text}` : text;
	}

	/** Human display: up to two decimals, trailing zeros trimmed. */
	toHuman(): string {
		const fixed = this.toFixed(2);
		return fixed.replace(/\.?0+$/, '').replace(/^-0$/, '0') || '0';
	}

	toNumber(): number {
		return Number(this.toString());
	}
}
