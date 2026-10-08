import { invalidate } from '$app/navigation';
import { undo } from '$lib/remote/pantry.remote';
import { newOperationId } from '$lib/client/ids';
import { remoteErrorMessage } from '$lib/client/remote';
import { pushToast } from '$lib/client/toast.svelte';

/**
 * The Undo button of a toast. Returns a function that reverses one event,
 * says how it went, and reloads the loads that depend on `depends`. Each call
 * has its own operation id, so a retry is not mistaken for the first call.
 */
export function createUndo({
	depends,
	done,
	failed
}: {
	/** The `depends()` key of the page that shows the data. */
	depends: string;
	/** The toast when the event was reversed. */
	done: string;
	/** The toast when it was not and the server gave no reason. */
	failed: string;
}) {
	let operationId = newOperationId();
	return async function undoEvent(eventId: string) {
		try {
			await undo({ operationId, eventId });
			pushToast(done, { kind: 'success' });
		} catch (err) {
			pushToast(remoteErrorMessage(err, failed), { kind: 'error' });
		}
		operationId = newOperationId();
		await invalidate(depends);
	};
}
