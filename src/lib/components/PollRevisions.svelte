<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { isHttpError } from '@sveltejs/kit';
	import { pushToast } from '$lib/client/toast.svelte';
	import { fetchFresh } from '$lib/client/remote';
	import { createPoller } from '$lib/client/poller';
	import { householdRevisions } from '$lib/remote/household.remote';

	/**
	 * Polls the tiny revision query while the page is visible and online.
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
		watch: ('pantry' | 'grocery' | 'plan')[];
		initial: { pantry: number; grocery: number; plan: number };
		intervalMs?: number;
		dependsOn: string;
		hasDirtyInput?: () => boolean;
	} = $props();

	let known = $derived({ ...initial });
	let changedNotice = $state(false);
	let lastChecked = $state<Date | null>(null);
	let refreshing = $state(false);

	const poller = createPoller({
		intervalMs: () => intervalMs,
		poll: () => {
			const forHousehold = householdId;
			return fetchFresh(householdRevisions({ household: forHousehold }));
		},
		async apply(rev) {
			if (rev.household !== householdId) return; // household switched meanwhile
			lastChecked = new Date();
			const changed = watch.some((k) => rev[k] !== known[k]);
			if (changed) {
				known = { pantry: rev.pantry, grocery: rev.grocery, plan: rev.plan };
				if (hasDirtyInput()) changedNotice = true;
				else await refresh();
			}
		},
		// stop polling: not authorized any more
		fatal: (err) => isHttpError(err, 401) || isHttpError(err, 403)
	});
	async function refresh() {
		refreshing = true;
		try {
			await invalidate(dependsOn);
			changedNotice = false;
		} finally {
			refreshing = false;
		}
	}
	onMount(() => {
		poller.start();
		return () => poller.stop();
	});
	export function manualRefresh() {
		poller.stop();
		refresh().then(() => {
			pushToast('Refreshed.', { timeout: 2000 });
			poller.start();
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
