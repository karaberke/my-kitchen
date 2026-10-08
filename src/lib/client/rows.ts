/** Helpers for editors made of rows the person can add, remove and reorder. */

/** A copy of `list` with the item at `from` moved to `to`; the same list when the move is empty. */
export function move<T>(list: T[], from: number, to: number): T[] {
	if (to < 0 || to >= list.length || from === to) return list;
	const copy = [...list];
	const [item] = copy.splice(from, 1);
	copy.splice(to, 0, item);
	return copy;
}

/** Focus `#<prefix>-<index>-<field>` after the row has rendered. */
export function focusRow(prefix: string, index: number, field: string) {
	queueMicrotask(() => document.getElementById(`${prefix}-${index}-${field}`)?.focus());
}
