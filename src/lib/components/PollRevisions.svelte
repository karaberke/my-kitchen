<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { isHttpError } from '@sveltejs/kit';
	import { pushToast } from '$lib/client/toast.svelte';
	import { fetchFresh } from '$lib/client/remote';
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
	let failures = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped by each check and on unmount, so an answer that arrives late is dropped. */
	let latest = 0;
	let refreshing = $state(false);

	async function check() {
		if (document.hidden || !navigator.onLine) return schedule();
		const mine = ++latest;
		const forHousehold = householdId;
		try {
			const rev = await fetchFresh(householdRevisions({ household: forHousehold }));
			if (mine !== latest) return; // a newer check, or the component is gone
			if (rev.household !== householdId) return; // household switched meanwhile
			failures = 0;
			lastChecked = new Date();
			const changed = watch.some((k) => rev[k] !== known[k]);
			if (changed) {
				known = { pantry: rev.pantry, grocery: rev.grocery, plan: rev.plan };
				if (hasDirtyInput()) changedNotice = true;
				else await refresh();
			}
		} catch (err) {
			if (mine !== latest) return;
			// stop polling: not authorized any more
			if (isHttpError(err, 401) || isHttpError(err, 403)) return;
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
		return () => {
			clearTimeout(timer);
			latest++;
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

<svelte:document onvisibilitychange={onVisible} />
<svelte:window ononline={onVisible} onfocus={onVisible} />

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
