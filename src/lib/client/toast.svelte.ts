export interface Toast {
	id: number;
	text: string;
	kind: 'info' | 'success' | 'error';
	action?: { label: string; href?: string; onClick?: () => void };
	timeout: number;
}

let seq = 0;

/** Small app-wide toast queue. Cleared on logout / household switch. */
export const toasts = $state<{ items: Toast[] }>({ items: [] });

export function pushToast(text: string, opts: Partial<Omit<Toast, 'id' | 'text'>> = {}): number {
	const id = ++seq;
	const toast: Toast = {
		id,
		text,
		kind: opts.kind ?? 'info',
		action: opts.action,
		timeout: opts.timeout ?? 6000
	};
	toasts.items = [...toasts.items.slice(-2), toast];
	if (toast.timeout > 0) setTimeout(() => dismissToast(id), toast.timeout);
	return id;
}

export function dismissToast(id: number) {
	toasts.items = toasts.items.filter((t) => t.id !== id);
}

export function clearToasts() {
	toasts.items = [];
}
