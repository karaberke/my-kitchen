<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { pushToast } from '$lib/client/toast.svelte';
	import { newOperationId } from '$lib/client/ids';
	import { fmtDateTime, fmtQty } from '$lib/client/format';

	let { data, form } = $props();
	type LooseForm =
		{ ok?: boolean; message?: string; review?: { reason?: string } } | null | undefined;
	const f = $derived(form as LooseForm);
	// svelte-ignore state_referenced_locally
	let opId = $state<string>(data.operationId);
	const dot: Record<string, string> = {
		purchase: 'bg-leaf',
		add_stock: 'bg-leaf',
		cook: 'bg-leaf',
		waste: 'bg-brick',
		correction: 'bg-honey',
		undo: 'bg-fog'
	};
	const kindLabel: Record<string, string> = {
		purchase: 'Purchase',
		add_stock: 'Stock added',
		cook: 'Cooked',
		waste: 'Waste',
		correction: 'Correction',
		undo: 'Undo'
	};
</script>

<PageHeader
	title="Inventory history"
	subtitle="{data.household?.name} · all members · newest first"
	back="/pantry"
/>
{#if f?.message}
	<div class="mb-3">
		<Alert kind="error"
			>{f.message}{#if f.review?.reason === 'consumed'}
				<a href="/pantry" class="font-bold underline">Record a correction in the pantry</a
				>{/if}</Alert
		>
	</div>
{/if}
{#if data.history.items.length === 0}
	<EmptyState
		title="No activity yet"
		body="Purchases, cooking, corrections and waste show up here with who did what."
	/>
{:else}
	<ul class="flex flex-col gap-2.5">
		{#each data.history.items as e (e.id)}
			<li class="card p-3.5 {e.reversedByEventId ? 'opacity-70' : ''}">
				<div class="flex gap-3">
					<span class="mt-1.5 h-2 w-2 flex-none rounded-full {dot[e.kind] ?? 'bg-fog'}"></span>
					<div class="min-w-0 flex-1">
						<div class="text-[13.5px] font-semibold {e.reversedByEventId ? 'line-through' : ''}">
							{e.summary}
						</div>
						<div class="mt-0.5 text-[11.5px] text-sage">
							{kindLabel[e.kind] ?? e.kind} · {e.actorName || 'someone'} · {fmtDateTime(
								e.occurredAt
							)}{e.reversedByEventId ? ' · undone' : ''}
						</div>
						{#if e.movements.length}
							<ul class="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-moss-soft">
								{#each e.movements as m, i (m.lotId + i)}
									<li>
										<span
											class="{m.delta.startsWith('-')
												? 'text-brick-dark'
												: 'text-leaf-dark'} font-semibold"
											>{m.delta.startsWith('-') ? '−' : '+'}{fmtQty(
												m.delta.replace('-', ''),
												m.unit
											)}</span
										>
										{m.ingredientName}
										<span class="text-sage-soft">→ {fmtQty(m.balanceAfter, m.unit)}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
					{#if e.canUndo}
						<form
							method="post"
							action="?/undo"
							use:enhance={() =>
								async ({ result, update }) => {
									await update({ reset: false });
									opId = newOperationId();
									if (result.type === 'success') {
										pushToast('Undone.', { kind: 'success' });
										await invalidate('app:history');
									}
								}}
						>
							<input type="hidden" name="operationId" value={opId} />
							<input type="hidden" name="eventId" value={e.id} />
							<button class="btn-secondary btn-sm">Undo</button>
						</form>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
	{#if data.history.nextCursor}
		<div class="mt-4 text-center">
			<a
				class="btn-secondary btn-sm"
				href="/pantry/history?before={encodeURIComponent(
					data.history.nextCursor.occurredAt + '|' + data.history.nextCursor.id
				)}">Older activity</a
			>
		</div>
	{/if}
{/if}
