<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import Sheet from '$lib/components/Sheet.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import { pushToast } from '$lib/client/toast.svelte';
	import { remoteErrorMessage } from '$lib/client/remote';
	import { fmtQty } from '$lib/client/format';
	import { tidyGroceryList } from '$lib/remote/grocery.remote';
	import type { TidyProposal, TidyValues } from '$lib/server/llm/grocery';

	/**
	 * Tidy with the assistant: ask (`start`), review, then apply only the checked
	 * changes. The page shows `pending` and `error` next to its own buttons.
	 */
	let {
		listId,
		open = $bindable(false),
		pending = $bindable(false),
		error = $bindable(null)
	}: {
		listId: string;
		open: boolean;
		/** True while the assistant reads the list. */
		pending: boolean;
		/** Why asking or applying failed; null when nothing did. */
		error: string | null;
	} = $props();

	let applying = $state(false);
	let conflict = $state<{ message: string; applied: number } | null>(null);
	let sent = $state<number | null>(null);
	let proposals = $state<TidyProposal[]>([]);
	let kept = $state<Record<string, boolean>>({});
	const keptProposals = $derived(proposals.filter((p) => kept[p.lineId]));

	export async function start() {
		if (pending) return;
		pending = true;
		error = null;
		conflict = null;
		try {
			const res = await tidyGroceryList({ listId });
			proposals = res.proposals;
			sent = res.sent;
			kept = Object.fromEntries(res.proposals.map((p) => [p.lineId, true]));
			open = true;
		} catch (err) {
			error = remoteErrorMessage(err, 'Could not reach the server. Check your connection.');
		} finally {
			pending = false;
		}
	}
	/** One side of a proposal as text; amount and unit read as one quantity. */
	function tidyQty(v: TidyValues): string {
		return v.amount === null ? (v.unit ?? 'no amount') : fmtQty(v.amount, v.unit);
	}
</script>

<Sheet
	bind:open
	title="Tidy the list"
	description="Suggestions from the assistant. Check them before you apply."
>
	{#if conflict}
		<Alert class="mb-3" kind="warn"
			>{conflict.message}
			{conflict.applied
				? `${conflict.applied} ${conflict.applied === 1 ? 'change was' : 'changes were'} saved. `
				: 'No other change was saved. '}Close this and ask the assistant again.</Alert
		>
		<button class="btn-secondary w-full" type="button" onclick={() => (open = false)}>Close</button>
	{:else if proposals.length === 0}
		<p class="mb-3 text-[13px] text-sage">
			{sent === 0 ? 'Nothing to tidy.' : 'The assistant found nothing to change.'}
		</p>
		<button class="btn-secondary w-full" type="button" onclick={() => (open = false)}>Close</button>
	{:else}
		{#if error}<Alert class="mb-3" kind="error">{error}</Alert>{/if}
		<form
			method="post"
			action="?/applyTidy"
			class="flex flex-col gap-3.5"
			use:enhance={() => {
				applying = true;
				error = null;
				return async ({ result, update }) => {
					applying = false;
					if (result.type === 'success') {
						await update({ reset: false });
						const applied = (result.data?.applied as number | undefined) ?? 0;
						open = false;
						pushToast(`${applied} ${applied === 1 ? 'item' : 'items'} tidied.`, {
							kind: 'success'
						});
						return;
					}
					const d = (result.type === 'failure' ? result.data : null) as {
						message?: string;
						applied?: number;
						conflicts?: string[];
					} | null;
					if (d?.conflicts?.length) {
						conflict = { message: d.message ?? '', applied: d.applied ?? 0 };
						proposals = [];
					} else {
						error = d?.message ?? 'Could not save the changes. Try again.';
					}
					await invalidate('app:grocery');
				};
			}}
		>
			<ul class="card overflow-hidden">
				{#each proposals as p (p.lineId)}
					<li class="divider-row px-3.5 py-3">
						<label class="flex min-h-10 items-start gap-2.5">
							<input
								type="checkbox"
								class="mt-0.5 h-5 w-5 flex-none accent-leaf"
								bind:checked={kept[p.lineId]}
							/>
							<span class="min-w-0 flex-1 text-[13px]">
								<span class="block font-semibold">{p.before.name}</span>
								{#if p.changed.includes('name')}
									<span class="block text-sage">
										Name: {p.before.name} → <strong class="text-ink">{p.after.name}</strong>
									</span>
								{/if}
								{#if p.changed.includes('amount') || p.changed.includes('unit')}
									<span class="block text-sage">
										Amount: {tidyQty(p.before)} →
										<strong class="text-ink">{tidyQty(p.after)}</strong>
									</span>
								{/if}
								{#if p.changed.includes('category')}
									<span class="block text-sage">
										Aisle: {p.before.category} →
										<strong class="text-ink">{p.after.category}</strong>
									</span>
								{/if}
							</span>
						</label>
					</li>
				{/each}
			</ul>
			{#each keptProposals as p, i (p.lineId)}
				<input type="hidden" name="change.{i}.lineId" value={p.lineId} />
				<input type="hidden" name="change.{i}.expectedRevision" value={p.revision} />
				{#if p.changed.includes('name')}
					<input type="hidden" name="change.{i}.name" value={p.after.name} />
				{/if}
				{#if p.changed.includes('amount') || p.changed.includes('unit')}
					<input type="hidden" name="change.{i}.amount" value={p.after.amount ?? ''} />
					<input type="hidden" name="change.{i}.unit" value={p.after.unit ?? ''} />
				{/if}
				{#if p.changed.includes('category')}
					<input type="hidden" name="change.{i}.category" value={p.after.category} />
				{/if}
			{/each}
			<div class="flex gap-2.5">
				<button
					class="btn-primary flex-[1.4]"
					disabled={keptProposals.length === 0 || applying}
					aria-busy={applying}
				>
					{applying
						? 'Applying…'
						: `Apply ${keptProposals.length} ${keptProposals.length === 1 ? 'change' : 'changes'}`}
				</button>
				<button class="btn-secondary flex-1" type="button" onclick={() => (open = false)}
					>Cancel</button
				>
			</div>
		</form>
	{/if}
</Sheet>
