<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { pushToast } from '$lib/client/toast.svelte';

	/**
	 * Polls the tiny revision endpoint while the page is visible and online.
	 * Only when a relevant counter changes are the page's loads re-run, unless
	 * the page reports unsaved input — then a notice is shown instead.
	 */
	let {
		householdId,
		watch,
		initial,
		intervalMs = 20000,
		dependsOn,
		hasDirtyInput = () => false
	}: {
		householdId: string;
		watch: ('pantry' | 'grocery')[];
		initial: { pantry: number; grocery: number };
		intervalMs?: number;
		dependsOn: string;
		hasDirtyInput?: () => boolean;
	} = $props();

	// svelte-ignore state_referenced_locally
	let known = $state({ ...initial });
	$effect(() => {
		known = { ...initial };
	});
	let changedNotice = $state(false);
	let lastChecked = $state<Date | null>(null);
	let failures = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	let refreshing = $state(false);

	async function check() {
		if (document.hidden || !navigator.onLine) return schedule();
		controller?.abort();
		controller = new AbortController();
		const forHousehold = householdId;
		try {
			const res = await fetch(`/api/revisions?household=${encodeURIComponent(forHousehold)}`, {
				signal: controller.signal,
				headers: { accept: 'application/json' }
			});
			if (res.status === 401 || res.status === 403) return; // stop polling: not authorized any more
			if (!res.ok) throw new Error(String(res.status));
			const rev = (await res.json()) as { household: string; pantry: number; grocery: number };
			if (rev.household !== householdId) return; // household switched meanwhile
			failures = 0;
			lastChecked = new Date();
			const changed = watch.some((k) => rev[k] !== known[k]);
			if (changed) {
				known = { pantry: rev.pantry, grocery: rev.grocery };
				if (hasDirtyInput()) changedNotice = true;
				else await refresh();
			}
		} catch (err) {
			if ((err as Error).name === 'AbortError') return;
			failures++;
		}
		schedule();
	}
	function schedule() {
		clearTimeout(timer);
		const backoff = Math.min(5, failures);
		timer = setTimeout(check, intervalMs * (1 + backoff));
	}
	async function refresh() {
		refreshing = true;
		try {
			await invalidate(dependsOn);
			changedNotice = false;
		} finally {
			refreshing = false;
		}
	}
	function onVisible() {
		if (!document.hidden) {
			clearTimeout(timer);
			check();
		}
	}
	onMount(() => {
		schedule();
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('online', onVisible);
		window.addEventListener('focus', onVisible);
		return () => {
			clearTimeout(timer);
			controller?.abort();
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('online', onVisible);
			window.removeEventListener('focus', onVisible);
		};
	});
	export function manualRefresh() {
		clearTimeout(timer);
		refresh().then(() => {
			pushToast('Refreshed.', { timeout: 2000 });
			schedule();
		});
	}
</script>

<div class="no-print flex items-center gap-2 text-[11.5px] text-sage" aria-live="polite">
	{#if changedNotice}
		<span class="rounded-full bg-honey-soft px-2.5 py-1 font-semibold text-honey-dark"
			>Changed by another member</span
		>
		<button class="font-bold text-leaf" onclick={refresh}>Load changes</button>
	{:else}
		<button class="font-bold text-leaf" onclick={manualRefresh} disabled={refreshing}
			>{refreshing ? 'Refreshing…' : 'Refresh'}</button
		>
		{#if lastChecked}<span class="hidden sm:inline"
				>checked {lastChecked.toLocaleTimeString(undefined, { timeStyle: 'short' })}</span
			>{/if}
	{/if}
</div>
