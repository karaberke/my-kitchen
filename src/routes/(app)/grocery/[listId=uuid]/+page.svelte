<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import type { ActionResult, SubmitFunction } from '@sveltejs/kit';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import PollRevisions from '$lib/components/PollRevisions.svelte';
	import IngredientAutocomplete from '$lib/components/IngredientAutocomplete.svelte';
	import StockFields from '$lib/components/StockFields.svelte';
	import { pushToast } from '$lib/client/toast.svelte';
	import { newOperationId } from '$lib/client/ids';
	import { createUndo } from '$lib/client/undo';
	import { reopenList, tidyGroceryList } from '$lib/remote/grocery.remote';
	import { remoteErrorMessage } from '$lib/client/remote';
	import { fmtDateTime, fmtNum, fmtQty } from '$lib/client/format';
	import { UNITS } from '$lib/shared/units';
	import { GROCERY_CATEGORIES, compareAisles } from '$lib/shared/grocery-categories';
	import { NOTE_MAX_CHARS } from '$lib/shared/text';
	import type { LineView, BatchView } from '$lib/server/grocery';
	import type { TidyProposal, TidyValues } from '$lib/server/llm/grocery';

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

	// tidy with the assistant: ask, review, then apply only the checked changes
	let tidyOpen = $state(false);
	let tidyPending = $state(false);
	let tidyApplying = $state(false);
	let tidyError = $state<string | null>(null);
	let tidyConflict = $state<{ message: string; applied: number } | null>(null);
	let tidySent = $state<number | null>(null);
	let proposals = $state<TidyProposal[]>([]);
	let kept = $state<Record<string, boolean>>({});
	const keptProposals = $derived(proposals.filter((p) => kept[p.lineId]));

	// add-line form state
	let addName = $state('');
	let addIngredientId = $state<string | null>(null);
	let addLabel = $state<string | null>(null);
	let addCreate = $state(false);
	// purchase form
	let buyUnit = $state('g');
	let buyName = $state('');
	let buyIngredientId = $state<string | null>(null);
	let buyLabel = $state<string | null>(null);
	let buyCreate = $state(false);
	function openPurchase(line: LineView) {
		purchase = line;
		buyUnit = line.unit ?? 'piece';
		buyName = line.name;
		buyIngredientId = line.ingredientId;
		buyLabel = line.ingredientId ? line.name : null;
		buyCreate = false;
	}

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
	async function startTidy() {
		if (tidyPending) return;
		tidyPending = true;
		tidyError = null;
		tidyConflict = null;
		try {
			const res = await tidyGroceryList({ listId: list.id });
			proposals = res.proposals;
			tidySent = res.sent;
			kept = Object.fromEntries(res.proposals.map((p) => [p.lineId, true]));
			tidyOpen = true;
		} catch (err) {
			tidyError = remoteErrorMessage(err, 'Could not reach the server. Check your connection.');
		} finally {
			tidyPending = false;
		}
	}
	/** One side of a proposal as text; amount and unit read as one quantity. */
	function tidyQty(v: TidyValues): string {
		return v.amount === null ? (v.unit ?? 'no amount') : fmtQty(v.amount, v.unit);
	}
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
							onclick={() => l.status === 'pending' && openPurchase(l)}
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
				onclick={startTidy}
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

<Sheet
	bind:open={addOpen}
	title="Add an item"
	description={list.status === 'draft'
		? 'Manual items keep their own amount; the pantry is only subtracted if you ask for it.'
		: 'Added to the trip in progress.'}
>
	{#if f?.message && f?.form === 'addLine'}<div class="mb-3">
			<Alert kind="error">{f.message}</Alert>
		</div>{/if}
	<form
		method="post"
		action="?/addLine"
		class="flex flex-col gap-3.5"
		use:enhance={mutate({
			onSuccess() {
				addName = '';
				addIngredientId = null;
				addLabel = null;
				addCreate = false;
				pushToast('Item added.', { kind: 'success' });
			}
		})}
	>
		<div>
			<label class="label" for="line-name">Item</label>
			<IngredientAutocomplete
				inputId="line-name"
				fieldName="name"
				bind:name={addName}
				bind:ingredientId={addIngredientId}
				bind:identityLabel={addLabel}
				bind:createIdentity={addCreate}
				placeholder="e.g. paper towels, rolled oats"
			/>
		</div>
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="line-amount"
					>Amount <span class="font-normal text-sage">(optional)</span></label
				>
				<input class="field" id="line-amount" name="amount" inputmode="decimal" placeholder="500" />
			</div>
			<div>
				<label class="label" for="line-unit">Unit</label>
				<select class="field" id="line-unit" name="unit"
					><option value="">—</option>{#each UNITS as u (u.id)}<option value={u.id}
							>{u.singular}</option
						>{/each}</select
				>
			</div>
			<div>
				<label class="label" for="line-category">Category</label>
				<select class="field" id="line-category" name="category"
					><option value="">Auto</option>{#each GROCERY_CATEGORIES as c (c)}<option value={c}
							>{c}</option
						>{/each}</select
				>
			</div>
			<div>
				<label class="label" for="line-note">Note</label>
				<input class="field" id="line-note" name="note" maxlength={NOTE_MAX_CHARS} />
			</div>
		</div>
		<label class="flex min-h-10 items-center gap-2.5 text-[13px]"
			><input type="checkbox" name="subtractPantry" class="h-5 w-5 accent-leaf" /> Subtract what the pantry
			already has</label
		>
		<button class="btn-primary w-full">Add to list</button>
	</form>
</Sheet>

<Sheet
	open={!!purchase}
	onclose={() => (purchase = null)}
	title="Confirm what you bought"
	description={purchase
		? `${purchase.name} · list asks for ${lineAmount(purchase)}. Packages rarely match, so enter the real amount; all of it goes into the pantry.`
		: ''}
>
	{#if purchase}
		{#if f?.message && f?.form === 'purchase'}<div class="mb-3">
				<Alert kind="error">{f.message}</Alert>
			</div>{/if}
		<form method="post" action="?/purchase" class="flex flex-col gap-3.5" use:enhance={mutate()}>
			<input type="hidden" name="operationId" value={opId} />
			<input type="hidden" name="lineId" value={purchase.id} />
			<StockFields
				idPrefix="buy"
				bind:unit={buyUnit}
				quantityLabel="Amount bought"
				quantityPlaceholder="e.g. 1000 for a 1 kg bag"
				locationLabel="Where it goes"
				locationPlaceholder="Fridge, Cupboard"
			/>
			{#if !purchase.ingredientId}
				<div>
					<label class="label" for="buy-ing">Track it as</label>
					<IngredientAutocomplete
						inputId="buy-ing"
						fieldName="newIngredientName"
						bind:name={buyName}
						bind:ingredientId={buyIngredientId}
						bind:identityLabel={buyLabel}
						bind:createIdentity={buyCreate}
					/>
					<p class="hint">Without a pantry ingredient the item can only be marked handled.</p>
				</div>
			{/if}
			{#if purchase.unit && buyUnit && purchase.unit !== buyUnit}
				<p class="text-[12px] text-honey-dark">
					Different unit from the list ({purchase.unit}). It is credited when convertible; otherwise
					the line is marked handled and the pantry still gets the full amount.
				</p>
			{/if}
			<div class="flex gap-2.5">
				<button class="btn-primary flex-[1.4]">Bought it</button>
				<button class="btn-secondary flex-1" name="handledOnly" value="1" formnovalidate
					>Mark handled, no stock</button
				>
			</div>
		</form>
	{/if}
</Sheet>

<Sheet
	open={!!editBatch}
	onclose={() => (editBatch = null)}
	title="Planned batch"
	description={editBatch
		? `${editBatch.recipeTitle} · base ${fmtNum(editBatch.baseServings)} servings`
		: ''}
>
	{#if editBatch}
		<form method="post" action="?/batch" class="flex flex-col gap-3.5" use:enhance={mutate()}>
			<input type="hidden" name="batchId" value={editBatch.id} />
			<div>
				<label class="label" for="batch-servings">Servings</label>
				<input
					class="field"
					id="batch-servings"
					name="servings"
					inputmode="decimal"
					value={editBatch.servings}
				/>
			</div>
			{#if editBatch.requirements.some((r) => r.optional)}
				<fieldset>
					<legend class="label">Optional ingredients to include</legend>
					{#each editBatch.requirements.filter((r) => r.optional) as r (r.id)}
						<label class="flex min-h-9 items-center gap-2.5 text-[13px]"
							><input
								type="checkbox"
								name="includeOptional"
								value={r.position}
								checked={r.include}
								class="h-5 w-5 accent-leaf"
							/>
							{r.name}</label
						>
					{/each}
				</fieldset>
			{/if}
			<div class="flex gap-2.5">
				<button class="btn-primary flex-1">Save</button>
				<button class="btn-danger flex-1" name="remove" value="1">Remove from plan</button>
			</div>
		</form>
	{/if}
</Sheet>

<Sheet
	open={!!editLine}
	onclose={() => (editLine = null)}
	title="Edit line"
	description={editLine
		? list.status === 'draft'
			? editLine.kind === 'manual'
				? 'Change the requested amount, category or note.'
				: 'Recipe amounts come from the plan; change servings on the batch instead. You can change category and note.'
			: 'Editing the remaining target keeps the credited purchases; the total target is adjusted consistently.'
		: ''}
>
	{#if editLine}
		<form
			method="post"
			action="?/line"
			class="flex flex-col gap-3.5"
			use:enhance={mutate({ reloadOnFailure: true })}
		>
			<input type="hidden" name="lineId" value={editLine.id} />
			<input type="hidden" name="expectedRevision" value={editLine.revision} />
			{#if list.status === 'shopping' || editLine.kind === 'manual'}
				<div>
					<label class="label" for="edit-amount"
						>{list.status === 'draft' ? 'Requested amount' : 'Remaining to buy'}
						{editLine.unit ? `(${editLine.unit})` : ''}</label
					>
					<input
						class="field"
						id="edit-amount"
						name="amount"
						inputmode="decimal"
						value={list.status === 'draft'
							? (editLine.demandAmount ?? '')
							: (editLine.remaining ?? '')}
					/>
					{#if list.status === 'shopping' && editLine.kind === 'recipe'}<p class="hint">
							Recipe-derived targets are never recalculated automatically; this is a deliberate
							override.
						</p>{/if}
				</div>
			{/if}
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="label" for="edit-category">Category</label>
					<select class="field" id="edit-category" name="category" value={editLine.category}
						>{#each GROCERY_CATEGORIES as c (c)}<option value={c}>{c}</option>{/each}</select
					>
				</div>
				<div>
					<label class="label" for="edit-note">Note</label>
					<input
						class="field"
						id="edit-note"
						name="note"
						value={editLine.note}
						maxlength={NOTE_MAX_CHARS}
					/>
				</div>
			</div>
			<div class="flex flex-wrap gap-2.5">
				<button class="btn-primary flex-1">Save</button>
				{#if list.status === 'shopping' && editLine.status === 'pending'}
					<button class="btn-secondary" name="status" value="handled">Mark handled</button>
				{:else if list.status === 'shopping' && editLine.status === 'handled'}
					<button class="btn-secondary" name="status" value="pending">Back to pending</button>
				{/if}
				{#if editLine.kind === 'manual' && editLine.purchasedAmount === '0'}
					<button class="btn-danger" name="remove" value="1">Remove</button>
				{/if}
			</div>
		</form>
	{/if}
</Sheet>

<Sheet
	bind:open={tidyOpen}
	title="Tidy the list"
	description="Suggestions from the assistant. Check them before you apply."
>
	{#if tidyConflict}
		<div class="mb-3">
			<Alert kind="warn"
				>{tidyConflict.message}
				{tidyConflict.applied
					? `${tidyConflict.applied} ${tidyConflict.applied === 1 ? 'change was' : 'changes were'} saved. `
					: 'No other change was saved. '}Close this and ask the assistant again.</Alert
			>
		</div>
		<button class="btn-secondary w-full" type="button" onclick={() => (tidyOpen = false)}
			>Close</button
		>
	{:else if proposals.length === 0}
		<p class="mb-3 text-[13px] text-sage">
			{tidySent === 0 ? 'Nothing to tidy.' : 'The assistant found nothing to change.'}
		</p>
		<button class="btn-secondary w-full" type="button" onclick={() => (tidyOpen = false)}
			>Close</button
		>
	{:else}
		{#if tidyError}<div class="mb-3"><Alert kind="error">{tidyError}</Alert></div>{/if}
		<form
			method="post"
			action="?/applyTidy"
			class="flex flex-col gap-3.5"
			use:enhance={() => {
				tidyApplying = true;
				tidyError = null;
				return async ({ result, update }) => {
					tidyApplying = false;
					if (result.type === 'success') {
						await update({ reset: false });
						const applied = (result.data?.applied as number | undefined) ?? 0;
						tidyOpen = false;
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
						tidyConflict = { message: d.message ?? '', applied: d.applied ?? 0 };
						proposals = [];
					} else {
						tidyError = d?.message ?? 'Could not save the changes. Try again.';
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
					disabled={keptProposals.length === 0 || tidyApplying}
					aria-busy={tidyApplying}
				>
					{tidyApplying
						? 'Applying…'
						: `Apply ${keptProposals.length} ${keptProposals.length === 1 ? 'change' : 'changes'}`}
				</button>
				<button class="btn-secondary flex-1" type="button" onclick={() => (tidyOpen = false)}
					>Cancel</button
				>
			</div>
		</form>
	{/if}
</Sheet>
