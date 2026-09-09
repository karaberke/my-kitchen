/** Client-side operation id: a fresh UUID per user-initiated mutation (kept across retries of the same submit). */
export function newOperationId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
	// Fallback for very old browsers: RFC 4122 v4 from Math.random (not cryptographically strong, only used as an idempotency key)
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}
