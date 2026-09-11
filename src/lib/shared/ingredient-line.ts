const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * One ingredient as a single line: "200 g onion, diced".
 *
 * An import keeps the original wording in `preparation` ("2 tbsp cream cheese"),
 * which the quantity and the name already say, so a note is appended only when
 * it adds something: one that repeats the name and carries an amount is dropped.
 */
export function ingredientLine(input: {
	quantity: string;
	name: string;
	preparation: string;
}): string {
	const head = `${input.quantity ? input.quantity + ' ' : ''}${input.name}`;
	const prep = input.preparation.trim();
	const repeatsLine = /\d/.test(prep) && norm(prep).includes(norm(input.name));
	return prep && !repeatsLine ? `${head}, ${prep}` : head;
}
