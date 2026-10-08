<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import type { ActionResult, SubmitFunction } from '@sveltejs/kit';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import PollRevisions from '$lib/components/PollRevisions.svelte';
	import GroceryAddSheet from '$lib/components/GroceryAddSheet.svelte';
	import GroceryPurchaseSheet from '$lib/components/GroceryPurchaseSheet.svelte';
	import GroceryBatchSheet from '$lib/components/GroceryBatchSheet.svelte';
	import GroceryLineSheet from '$lib/components/GroceryLineSheet.svelte';
	import GroceryTidySheet from '$lib/components/GroceryTidySheet.svelte';
	import { pushToast } from '$lib/client/toast.svelte';
	import { newOperationId } from '$lib/client/ids';
	import { createUndo } from '$lib/client/undo';
	import { reopenList } from '$lib/remote/grocery.remote';
	import { fmtDateTime, fmtNum, fmtQty } from '$lib/client/format';
	import { compareAisles } from '$lib/shared/grocery-categories';
	import type { LineView, BatchView } from '$lib/server/grocery';

	let { data, form } = $props();
	const list = $derived(data.list);
	const f = $derived(form);
	let view = $state<'pending' | 'purchased' | 'all'>('pending');
	let addOpen = $state(false);
	let purchase = $state<LineView | null>(null);
	let editBatch = $state<BatchView | null>(null);
	let editLine = $state<LineView | null>(null);
	let opId = $derived<string>(data.operationId);
	const dirty = () => addOpen || !!purchase || !!editBatch || !!editLine || tidyOpen;

	// tidy with the assistant: the sheet owns the flow, the page shows its status
	let tidy = $state<ReturnType<typeof GroceryTidySheet>>();
	let tidyOpen = $state(false);
	let tidyPending = $state(false);
	let tidyError = $state<string | null>(null);

	const visibleLines = $derived(
		list.lines.filter(
			(l) =>
				view === 'all' || (view === 'pending' ? l.status === 'pending' : l.status !== 'pending')
		)
	);
	const sections = $derived.by(() => {
		const groups: Record<string, LineView[]> = {};
		for (const l of visibleLines) (groups[l.category] ??= []).push(l);
		return Object.entries(groups).sort((a, b) => compareAisles(a[0], b[0]));
	});
	const pendingCount = $derived(list.lines.filter((l) => l.status === 'pending').length);
	const doneCount = $derived(list.lines.length - pendingCount);

	function lineAmount(l: LineView): string {
		if (list.status === 'draft')
			return l.targetAmount === null ? '?' : fmtQty(l.targetAmount, l.unit);
		if (l.remaining === null) return '?';
		return fmtQty(l.remaining, l.unit);
	}
	function lineMath(l: LineView): string {
		const parts: string[] = [];
		if (l.kind === 'recipe' && l.demandAmount) parts.push(`need ${fmtQty(l.demandAmount, l.unit)}`);
		if (l.kind === 'manual' && l.demandAmount)
			parts.push(`asked ${fmtQty(l.demandAmount, l.unit)}`);
		if (l.stockConsidered !== null) parts.push(`pantry ${fmtQty(l.stockConsidered, l.unit)}`);
		if (list.status !== 'draft' && l.targetAmount !== null)
			parts.push(`target ${fmtQty(l.targetAmount, l.unit)}`);
		if (list.status !== 'draft' && l.purchasedAmount !== '0')
			parts.push(`bought ${fmtQty(l.purchasedAmount, l.unit)}`);
		return parts.join(' · ');
	}
	const reasonText: Record<string, string> = {
		unknown_amount: 'No amount given — decide while shopping',
		no_identity: 'Not matched to a pantry ingredient — pantry not considered',
		incompatible_stock_units: 'Pantry has this in other units — review'
	};

	function afterMutation(result: ActionResult) {
		if (result.type !== 'success') return;
		const d = result.data ?? {};
		const unitForToast = purchase?.unit ?? null;
		opId = newOperationId();
		addOpen = false;
		purchase = null;
		editBatch = null;
		editLine = null;
		if (d.action === 'purchase') {
			const eventId = d.eventId as string | null;
			const status = d.lineStatus as string;
			pushToast(
				status === 'handled'
					? 'Marked as handled.'
					: status === 'purchased'
						? 'Bought — target complete. Pantry updated.'
						: `Bought — ${fmtQty(d.remaining as string, unitForToast)} still to buy. Pantry updated.`,
				{
					kind: 'success',
					action: eventId ? { label: 'Undo', onClick: () => undoNow(eventId) } : undefined
				}
			);
		} else if (d.action === 'start')
			pushToast('Shopping started. Targets are locked; purchases now count against them.', {
				kind: 'success'
			});
		else if (d.action === 'complete')
			pushToast('Trip completed and archived.', {
				kind: 'success',
				action: { label: 'Undo', onClick: () => reopenNow() }
			});
		else if (d.action === 'reopen')
			pushToast('Trip reopened. You can shop again.', { kind: 'success' });
		else if (d.action === 'refresh')
			pushToast('Preview recalculated from current pantry.', { kind: 'success' });
	}
	/**
	 * `use:enhance` for a mutation: keep what was typed, then run the shared
	 * after-effects. `onSuccess` adds what only one form needs. A failure does
	 * not reload by itself, so `reloadOnFailure` fetches the list again when
	 * the server rejected the change because the data moved on.
	 */
	const mutate =
		({
			onSuccess,
			reloadOnFailure = false
		}: { onSuccess?: () => void; reloadOnFailure?: boolean } = {}): SubmitFunction =>
		() =>
		async ({ result, update }) => {
			await update({ reset: false });
			afterMutation(result);
			if (result.type === 'success') onSuccess?.();
			else if (result.type === 'failure' && reloadOnFailure) await invalidate('app:grocery');
		};
	const undoNow = createUndo({
		depends: 'app:grocery',
		done: 'Purchase undone: pantry and list credit reversed.',
		failed: 'Could not undo. See history for details.'
	});
	async function reopenNow() {
		try {
			await reopenList({ listId: list.id, expectedRevision: list.revision });
			pushToast('Trip reopened. You can shop again.', { kind: 'success' });
		} catch {
			pushToast('Could not reopen the trip. Reload the page and try again.', { kind: 'error' });
		}
		await invalidate('app:grocery');
	}
	const statusLabel: Record<string, string> = {
		draft: 'Draft · review before shopping',
		shopping: 'Shopping',
		completed: 'Completed'
	};
</script>

<PageHeader
	title={list.name}
	subtitle="{statusLabel[list.status]} · {data.household?.name}"
	back="/grocery/lists"
>
	{#if data.household}<PollRevisions
			householdId={data.household.id}
			watch={['grocery', 'pantry']}
			initial={data.revisions}
			intervalMs={data.pollMs}
			dependsOn="app:grocery"
			hasDirtyInput={dirty}
		/>{/if}
</PageHeader>

{#if f?.message && !f.form && !dirty()}
	<div class="mb-3">
		<Alert kind={f.review ? 'warn' : 'error'}
			>{f.message}{#if f.review?.changedRecipes?.length}
				({f.review.changedRecipes.join(', ')}){/if}</Alert
		>
	</div>
{/if}
{#if list.status === 'draft'}
	{#if list.pantryChanged || list.anyRecipeChanged}
		<div class="mb-3">
			<Alert kind="warn"
				>{list.pantryChanged ? 'The pantry changed since this preview.' : ''}
				{list.anyRecipeChanged ? 'A planned recipe changed since it was added.' : ''} Recalculate to see
				current numbers; starting shopping checks this again.
				<form method="post" action="?/refresh" class="mt-2" use:enhance={mutate()}>
					<button class="btn-secondary btn-sm">Recalculate</button>
				</form></Alert
			>
		</div>
	{/if}
	<div class="card mb-4 p-3.5">
		<div class="flex items-center justify-between gap-2">
			<h2 class="text-[15px]">Planned recipes</h2>
			<a href="/recipes" class="btn-secondary btn-sm">+ Add recipes</a>
		</div>
		{#if list.batches.length === 0}
			<p class="mt-2 text-[13px] text-sage">
				Open a recipe and use “Add to grocery list”. Matching ingredients are combined before the
				pantry is subtracted once.
			</p>
		{:else}
			<ul class="mt-2 flex flex-col gap-1.5">
				{#each list.batches as b (b.id)}
					<li class="flex items-center gap-2 rounded-[12px] bg-parchment px-3 py-2 text-[13px]">
						<span class="flex-1"
							>{#if b.recipeId}<a href="/recipes/{b.recipeId}" class="font-semibold"
									>{b.recipeTitle}</a
								>{:else}<span class="font-semibold">{b.recipeTitle}</span>
								<span class="text-sage">(deleted)</span>{/if} · {fmtNum(b.servings)} servings{#if b.recipeChanged}
								<span class="pill bg-honey-soft text-honey-dark">recipe changed</span>{/if}</span
						>
						<button class="btn-ghost btn-sm h-8" onclick={() => (editBatch = b)}>Edit</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{:else if list.status === 'shopping'}
	<p class="mb-3 text-[12px] text-sage">
		Started {fmtDateTime(list.startedAt)}. Targets were fixed when shopping started; the pantry is
		not subtracted again. Plan more recipes in a new draft.
	</p>
{:else}
	<p class="mb-3 text-[12px] text-sage">
		Completed {fmtDateTime(list.completedAt)}. Purchases stay in history.
	</p>
{/if}

<div class="flex items-center justify-between gap-2">
	<div class="text-[11.5px] text-sage">
		{list.lines.length === 0
			? 'Empty list'
			: list.status === 'draft'
				? `${list.lines.length} lines · preview`
				: `${doneCount} of ${list.lines.length} done`}
	</div>
	<div
		class="flex rounded-[10px] bg-linen p-0.5 text-[11.5px] font-bold"
		role="group"
		aria-label="Show"
	>
		{#each [['pending', 'To buy'], ['purchased', 'Done'], ['all', 'All']] as [id, label] (id)}
			<button
				class="rounded-[8px] px-2.5 py-1.5 {view === id ? 'bg-card text-ink' : 'text-sage'}"
				aria-pressed={view === id}
				onclick={() => (view = id as typeof view)}>{label}</button
			>
		{/each}
	</div>
</div>

{#if list.lines.length === 0}
	<EmptyState title="Nothing on the list yet" body="Add recipes, or add an item by hand.">
		{#if list.status !== 'completed'}<button class="btn-primary" onclick={() => (addOpen = true)}
				>Add item</button
			>{/if}
	</EmptyState>
{:else if visibleLines.length === 0}
	<EmptyState
		title={view === 'pending' ? 'All done here' : 'Nothing here'}
		body={view === 'pending' ? 'Everything is bought or handled.' : ''}
	/>
{/if}

{#each sections as [category, lines] (category)}
	<section class="mt-4">
		<h2 class="eyebrow px-0.5 pb-2 font-sans">{category} · {lines.length}</h2>
		<ul class="card overflow-hidden">
			{#each lines as l (l.id)}
				<li
					class="divider-row flex items-start gap-3 px-3.5 py-3 {l.status !== 'pending'
						? 'bg-[#f7f4ec]'
						: ''}"
				>
					{#if list.status === 'shopping'}
						<button
							class="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-[8px] border-[1.5px] text-[13px] text-cream {l.status !==
							'pending'
								? 'border-leaf bg-leaf'
								: 'border-[#c6c2a6] bg-card'}"
							aria-label={l.status === 'pending' ? `Buy ${l.name}` : `${l.name} done`}
							onclick={() => l.status === 'pending' && (purchase = l)}
							disabled={l.status !== 'pending'}>{l.status !== 'pending' ? '✓' : ''}</button
						>
					{:else}
						<span
							class="mt-2 h-2 w-2 flex-none rounded-full {l.unresolvedReason
								? 'bg-honey'
								: 'bg-fog'}"
						></span>
					{/if}
					<div class="min-w-0 flex-1">
						<div
							class="text-[14px] font-semibold {l.status !== 'pending'
								? 'text-sage line-through'
								: ''}"
						>
							{l.name}{#if l.kind === 'manual'}
								<span class="pill bg-linen font-semibold text-sage">manual</span>{/if}
						</div>
						<div class="mt-0.5 text-[11.5px] text-sage">{lineMath(l)}</div>
						{#if l.sources.length}<div class="mt-0.5 text-[11px] text-sage-soft">
								For {l.sources
									.map((s) => `${s.recipeTitle}${s.amount ? ` (${fmtQty(s.amount, s.unit)})` : ''}`)
									.join(', ')}
							</div>{/if}
						{#if l.unresolvedReason}<div class="mt-0.5 text-[11.5px] text-honey-dark">
								⚑ {reasonText[l.unresolvedReason] ?? l.unresolvedReason}{#if l.otherStock.length}: {l.otherStock
										.map((o) => fmtQty(o.quantity, o.unit))
										.join(', ')}{/if}
							</div>{/if}
						{#if l.note}<div class="mt-0.5 text-[11.5px] text-moss-soft">{l.note}</div>{/if}
					</div>
					<div class="flex flex-none flex-col items-end gap-1">
						<div class="text-[13px] font-bold">{lineAmount(l)}</div>
						{#if list.status !== 'completed'}
							<button class="btn-ghost btn-sm h-8 px-2" onclick={() => (editLine = l)}>Edit</button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	</section>
{/each}

{#if data.aiEnabled && list.status !== 'completed' && list.lines.length > 0}
	<div class="no-print mt-4" aria-live="polite">
		{#if tidyPending}
			<p class="mb-2 text-[12.5px] text-sage">
				Reading your list with the assistant… this can take a minute.
			</p>
		{/if}
		{#if tidyError}<div class="mb-2"><Alert kind="error">{tidyError}</Alert></div>{/if}
	</div>
{/if}

<div class="no-print mt-6 flex flex-wrap gap-2.5">
	{#if list.status !== 'completed'}
		<button class="btn-secondary" onclick={() => (addOpen = true)}>Add item</button>
		{#if data.aiEnabled && list.lines.length > 0}
			<button
				class="btn-secondary"
				onclick={() => tidy?.start()}
				disabled={tidyPending}
				aria-busy={tidyPending}
			>
				{tidyPending ? 'Reading the list…' : 'Tidy with assistant'}
			</button>
		{/if}
	{/if}
	{#if list.status === 'draft'}
		<form method="post" action="?/start" use:enhance={mutate({ reloadOnFailure: true })}>
			<input type="hidden" name="expectedRevision" value={list.revision} />
			<button class="btn-primary" disabled={list.lines.length === 0}>Start shopping</button>
		</form>
		<form method="post" action="?/deleteDraft" use:enhance>
			<button class="btn-ghost text-brick-dark">Delete draft</button>
		</form>
	{:else if list.status === 'shopping'}
		<form method="post" action="?/complete" use:enhance={mutate()}>
			<input type="hidden" name="expectedRevision" value={list.revision} />
			<button class="btn-primary">Complete trip</button>
		</form>
	{:else}
		<form method="post" action="?/reopen" use:enhance={mutate({ reloadOnFailure: true })}>
			<input type="hidden" name="expectedRevision" value={list.revision} />
			<button class="btn-secondary">Reopen trip</button>
		</form>
	{/if}
	<a href="/grocery/lists" class="btn-ghost">All lists</a>
</div>

<GroceryAddSheet
	bind:open={addOpen}
	listStatus={list.status}
	error={f?.form === 'addLine' ? f.message : ''}
	{mutate}
/>

<GroceryPurchaseSheet
	line={purchase}
	{lineAmount}
	operationId={opId}
	error={f?.form === 'purchase' ? f.message : ''}
	{mutate}
	onclose={() => (purchase = null)}
/>

<GroceryBatchSheet batch={editBatch} {mutate} onclose={() => (editBatch = null)} />

<GroceryLineSheet
	line={editLine}
	listStatus={list.status}
	{mutate}
	onclose={() => (editLine = null)}
/>

<GroceryTidySheet
	bind:this={tidy}
	listId={list.id}
	bind:open={tidyOpen}
	bind:pending={tidyPending}
	bind:error={tidyError}
/>
