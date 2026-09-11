<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import PollRevisions from '$lib/components/PollRevisions.svelte';
	import IngredientAutocomplete from '$lib/components/IngredientAutocomplete.svelte';
	import BarcodeScanner from '$lib/components/BarcodeScanner.svelte';
	import ScanConfirm, { type Scan } from '$lib/components/ScanConfirm.svelte';
	import { pushToast } from '$lib/client/toast.svelte';
	import { newOperationId } from '$lib/client/ids';
	import { fmtDate, fmtQty } from '$lib/client/format';
	import { UNITS } from '$lib/shared/units';
	import type { PantryGroup, PantryLotView } from '$lib/server/pantry';

	let { data, form } = $props();
	type LooseForm =
		| {
				ok?: boolean;
				action?: string;
				message?: string;
				form?: string;
				review?: { lot?: { quantity: string; unit: string } };
				eventId?: string | null;
				noChange?: boolean;
		  }
		| null
		| undefined;
	const f = $derived(form as LooseForm);
	let q = $derived(data.filters.q);

	type Mode = 'add' | 'correct' | 'waste' | 'metadata';
	let sheet = $state<{ mode: Mode; group?: PantryGroup; lot?: PantryLotView } | null>(null);
	let opId = $derived<string>(data.operationId);
	let undoOp = $state(newOperationId());

	// add form state
	let addName = $state('');
	let addIngredientId = $state<string | null>(null);
	let addLabel = $state<string | null>(null);
	let addCreate = $state(false);
	let addUnit = $state('g');
	let sheetBusy = $state(false);
	const dirtyInput = () => !!sheet;

	function openAdd(group?: PantryGroup) {
		addName = group?.name ?? '';
		addIngredientId = group?.ingredientId ?? null;
		addLabel = group?.name ?? null;
		addCreate = false;
		addUnit = group?.lots[0]?.unit ?? 'g';
		sheet = { mode: 'add', group };
	}
	function link(changes: Record<string, string | null>) {
		const u = new URL(page.url);
		for (const [k, v] of Object.entries(changes)) {
			if (v) u.searchParams.set(k, v);
			else u.searchParams.delete(k);
		}
		return u.pathname + u.search;
	}
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	function onSearch() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(
			() => goto(link({ q }), { keepFocus: true, replaceState: true, noScroll: true }),
			300
		);
	}
	const filterChips = $derived([
		{ id: 'all', label: 'All' },
		{ id: 'use_soon', label: 'Review · use soon' },
		{ id: 'dated', label: 'With date' },
		{ id: 'undated', label: 'No date' }
	]);
	function afterSuccess(result: { type: string; data?: Record<string, unknown> }) {
		if (result.type !== 'success') return;
		const d = result.data ?? {};
		sheet = null;
		opId = newOperationId();
		const eventId = d.eventId as string | undefined;
		if (d.noChange) pushToast('Count matched the tracked balance — nothing changed.');
		else if (d.action === 'metadata') pushToast('Lot details saved.', { kind: 'success' });
		else
			pushToast(
				d.action === 'add'
					? 'Stock added.'
					: d.action === 'correct'
						? 'Balance corrected.'
						: 'Waste recorded.',
				{
					kind: 'success',
					action: eventId ? { label: 'Undo', onClick: () => undoEventNow(eventId) } : undefined
				}
			);
	}
	/* --- scanning ------------------------------------------------------- */

	let scannerOpen = $state(false);
	let scan = $state<Scan | null>(null);
	let scanOpId = $state(newOperationId());
	let looking = $state(false);
	let scanner: BarcodeScanner | undefined = $state();

	/**
	 * A decoded or typed number goes to the server, which validates it again and
	 * answers what it means for this household. Nothing is stored by this call.
	 */
	async function lookUp(code: { raw: string; symbology: string | null }) {
		looking = true;
		try {
			// Built in one go: nothing here is reactive, and a mutable
			// URLSearchParams in a component is what the lint rule is guarding.
			const query = new URLSearchParams(
				code.symbology ? { code: code.raw, symbology: code.symbology } : { code: code.raw }
			).toString();
			const res = await fetch(`/api/barcode?${query}`);
			const body = await res.json().catch(() => null);
			if (!res.ok || !body?.ok) {
				pushToast(body?.message ?? 'That barcode could not be read.', { kind: 'error' });
				scanner?.resume();
				return;
			}
			scannerOpen = false;
			scan = {
				code: code.raw,
				symbology: code.symbology,
				lookup: body.lookup,
				suggestion: body.suggestion
			};
		} catch {
			pushToast('Could not reach the server. Check your connection.', { kind: 'error' });
			scanner?.resume();
		} finally {
			looking = false;
		}
	}

	function afterScanSave(result: { type: string; data?: Record<string, unknown> }) {
		if (result.type !== 'success') return;
		const d = result.data ?? {};
		scan = null;
		scanOpId = newOperationId();
		const eventId = d.eventId as string | undefined;
		pushToast('Stock added.', {
			kind: 'success',
			action: eventId ? { label: 'Undo', onClick: () => undoEventNow(eventId) } : undefined
		});
		// Straight back to the viewfinder for the next item in the trolley.
		scannerOpen = true;
	}

	async function undoEventNow(eventId: string) {
		const fd = new FormData();
		fd.set('operationId', undoOp);
		fd.set('eventId', eventId);
		const res = await fetch('/pantry?/undo', {
			method: 'POST',
			body: fd,
			headers: { 'x-sveltekit-action': 'true' }
		});
		const json = await res.json().catch(() => null);
		undoOp = newOperationId();
		if (json?.type === 'success') pushToast('Undone.', { kind: 'success' });
		else
			pushToast(json?.data ? (JSON.parse(json.data)?.[1] ?? 'Could not undo') : 'Could not undo', {
				kind: 'error'
			});
		await invalidate('app:pantry');
	}
</script>

<PageHeader
	title="Pantry"
	subtitle="{data.household?.name} · {data.overview.activeCount} {data.overview.activeCount === 1
		? 'lot'
		: 'lots'} in stock"
>
	<a href="/pantry/history" class="btn-ghost btn-sm hidden sm:inline-flex">History</a>
	<button class="btn-secondary btn-sm rounded-full" onclick={() => (scannerOpen = true)}
		>Scan</button
	>
	<button class="btn-primary btn-sm rounded-full" onclick={() => openAdd()}>+ Add stock</button>
</PageHeader>

{#if f?.message && !sheet}
	<div class="mb-3"><Alert kind="error">{f.message}</Alert></div>
{/if}

<div
	class="flex h-11 items-center gap-2 rounded-[14px] border border-sand-dark bg-linen px-3.5"
	role="search"
>
	<span class="text-sage-soft" aria-hidden="true">⌕</span>
	<label class="sr-only" for="pantry-search">Search pantry</label>
	<input
		id="pantry-search"
		class="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-sage-soft"
		placeholder="Search pantry"
		bind:value={q}
		oninput={onSearch}
		autocomplete="off"
	/>
</div>
<div
	class="-mx-4 mt-3 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
	role="group"
	aria-label="Filters"
>
	{#each filterChips as c (c.id)}
		<a
			href={link({ filter: c.id === 'all' ? null : c.id })}
			class="chip {data.filters.filter === c.id ? 'chip-on' : ''}"
			aria-current={data.filters.filter === c.id ? 'true' : undefined}>{c.label}</a
		>
	{/each}
	{#each data.overview.locations as loc (loc)}
		<a
			href={link({ location: data.filters.location === loc ? null : loc })}
			class="chip bg-card {data.filters.location === loc ? 'chip-on' : ''}">{loc}</a
		>
	{/each}
</div>
<div class="mt-2 flex items-center justify-between">
	<span class="text-[11.5px] text-sage"
		>Dates are for your review only. Nothing is removed automatically.</span
	>
	{#if data.household}<PollRevisions
			householdId={data.household.id}
			watch={['pantry']}
			initial={data.revisions}
			intervalMs={data.pollMs}
			dependsOn="app:pantry"
			hasDirtyInput={dirtyInput}
		/>{/if}
</div>

{#if data.overview.groups.length === 0}
	<EmptyState
		title={data.filters.q || data.filters.filter !== 'all' || data.filters.location
			? 'Nothing matches'
			: 'Pantry is empty'}
		body={data.filters.q || data.filters.filter !== 'all' || data.filters.location
			? 'Try another filter.'
			: 'Add what you have on hand, or confirm purchases while shopping and they land here automatically.'}
	>
		<button class="btn-primary" onclick={() => openAdd()}>Add stock</button>
	</EmptyState>
{:else}
	<ul class="mt-3 flex flex-col gap-2.5">
		{#each data.overview.groups as g (g.ingredientId)}
			<li class="card p-3.5">
				<div class="flex items-baseline gap-2">
					<div class="flex-1 text-[14px] font-semibold">{g.name}</div>
					<div class="text-[14px] font-bold">
						{g.totals.map((t) => fmtQty(t.quantity, t.unit)).join(' + ')}
					</div>
				</div>
				<div
					class="mt-0.5 text-[11.5px] {g.expired
						? 'text-brick-dark'
						: g.useSoon
							? 'text-honey-dark'
							: 'text-sage'}"
				>
					{g.category}{g.earliestExpiry
						? ` · earliest date ${fmtDate(g.earliestExpiry)}`
						: ''}{g.expired ? ' · past date, review' : g.useSoon ? ' · use soon' : ''}
				</div>
				<ul class="mt-2.5 flex flex-col gap-1.5">
					{#each g.lots as lot (lot.id)}
						<li
							class="flex flex-wrap items-center gap-2 rounded-[12px] bg-parchment px-3 py-2 text-[12.5px]"
						>
							<span class="font-semibold">{fmtQty(lot.quantity, lot.unit)}</span>
							<span class="text-sage"
								>{lot.location || 'no location'}{lot.expiresOn
									? ` · ${lot.expired ? 'past ' : 'use by '}${fmtDate(lot.expiresOn)}`
									: ' · no date'}{lot.note ? ` · ${lot.note}` : ''}</span
							>
							<span class="flex-1"></span>
							<button
								class="btn-secondary btn-sm h-8"
								onclick={() => (sheet = { mode: 'correct', group: g, lot })}>Correct</button
							>
							<button
								class="btn-danger btn-sm h-8"
								onclick={() => (sheet = { mode: 'waste', group: g, lot })}>Waste</button
							>
							<button
								class="btn-ghost btn-sm h-8"
								onclick={() => (sheet = { mode: 'metadata', group: g, lot })}>Details</button
							>
						</li>
					{/each}
				</ul>
				<button class="btn-secondary btn-sm mt-2.5" onclick={() => openAdd(g)}>Add stock</button>
			</li>
		{/each}
	</ul>
{/if}

<Sheet
	open={!!sheet}
	onclose={() => (sheet = null)}
	title={sheet?.mode === 'add'
		? 'Add stock'
		: sheet?.mode === 'correct'
			? 'Correct the quantity'
			: sheet?.mode === 'waste'
				? 'Record waste'
				: 'Lot details'}
	description={sheet?.mode === 'add'
		? 'A new lot with its own date and location. Keep separate purchases separate.'
		: sheet?.mode === 'correct'
			? `Count what is really there. Tracked: ${sheet?.lot ? fmtQty(sheet.lot.quantity, sheet.lot.unit) : ''}. The difference is recorded as a correction.`
			: sheet?.mode === 'waste'
				? `Removing ${sheet?.group?.name} without cooking it. Tracked: ${sheet?.lot ? fmtQty(sheet.lot.quantity, sheet.lot.unit) : ''}.`
				: 'Location, date and note only. Quantity changes go through Correct.'}
>
	{#if sheet}
		{#if f?.message}
			<div class="mb-3">
				<Alert kind="error"
					>{f.message}{#if f.review?.lot}
						Now tracked: {fmtQty(f.review.lot.quantity, f.review.lot.unit)}.
						<button
							class="font-bold underline"
							onclick={() => invalidate('app:pantry').then(() => (sheet = null))}>Reload</button
						>{/if}</Alert
				>
			</div>
		{/if}
		<form
			method="post"
			action="?/{sheet.mode === 'metadata' ? 'metadata' : sheet.mode}"
			class="flex flex-col gap-3.5"
			use:enhance={() => {
				sheetBusy = true;
				return async ({ result, update }) => {
					sheetBusy = false;
					await update({ reset: false });
					afterSuccess(result as never);
				};
			}}
		>
			<input type="hidden" name="operationId" value={opId} />
			{#if sheet.mode === 'add'}
				<div>
					<label class="label" for="add-name">Ingredient</label>
					<IngredientAutocomplete
						inputId="add-name"
						fieldName="name"
						bind:name={addName}
						bind:ingredientId={addIngredientId}
						bind:identityLabel={addLabel}
						bind:createIdentity={addCreate}
					/>
					{#if !addIngredientId}<p class="hint">
							Pick a match so stock can be used by recipes, or create it as your own ingredient.
						</p>{/if}
				</div>
				{#if !addIngredientId}
					<div>
						<label class="label" for="add-category">Category (for new ingredients)</label>
						<select class="field" id="add-category" name="category"
							>{#each data.categories as c (c)}<option value={c}>{c}</option>{/each}</select
						>
					</div>
				{/if}
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="label" for="add-qty">Quantity</label>
						<input
							class="field"
							id="add-qty"
							name="quantity"
							inputmode="decimal"
							required
							placeholder="500"
						/>
					</div>
					<div>
						<label class="label" for="add-unit">Unit</label>
						<select class="field" id="add-unit" name="unit" bind:value={addUnit}
							>{#each UNITS as u (u.id)}<option value={u.id}
									>{u.singular}{u.plural !== u.singular ? ` / ${u.plural}` : ''}</option
								>{/each}</select
						>
						<p class="hint">
							A can or bag is not a known weight — enter the contents if you know them.
						</p>
					</div>
					<div>
						<label class="label" for="add-loc">Location</label>
						<input
							class="field"
							id="add-loc"
							name="location"
							list="loc-options"
							placeholder="Fridge, Freezer, Cupboard"
							maxlength="60"
						/>
					</div>
					<div>
						<label class="label" for="add-exp"
							>Use-by date <span class="font-normal text-sage">(optional)</span></label
						>
						<input class="field" id="add-exp" name="expiresOn" type="date" />
					</div>
				</div>
				<div>
					<label class="label" for="add-note"
						>Note <span class="font-normal text-sage">(optional)</span></label
					>
					<input class="field" id="add-note" name="note" maxlength="300" />
				</div>
			{:else if sheet.lot}
				<input type="hidden" name="lotId" value={sheet.lot.id} />
				<input type="hidden" name="expectedRevision" value={sheet.lot.revision} />
				{#if sheet.mode === 'correct'}
					<div>
						<label class="label" for="correct-qty">Counted amount ({sheet.lot.unit})</label>
						<input
							class="field"
							id="correct-qty"
							name="checkedQuantity"
							inputmode="decimal"
							required
							value={sheet.lot.quantity}
						/>
					</div>
					<div>
						<label class="label" for="correct-note"
							>Note <span class="font-normal text-sage">(optional)</span></label
						>
						<input
							class="field"
							id="correct-note"
							name="note"
							placeholder="e.g. weighed the bag"
							maxlength="300"
						/>
					</div>
				{:else if sheet.mode === 'waste'}
					<div>
						<label class="label" for="waste-qty">Amount thrown away ({sheet.lot.unit})</label>
						<input
							class="field"
							id="waste-qty"
							name="quantity"
							inputmode="decimal"
							required
							placeholder={sheet.lot.quantity}
						/>
					</div>
					<div>
						<label class="label" for="waste-reason"
							>Reason <span class="font-normal text-sage">(optional)</span></label
						>
						<input
							class="field"
							id="waste-reason"
							name="reason"
							placeholder="past its date, spoiled"
							maxlength="300"
						/>
					</div>
				{:else}
					<div class="grid grid-cols-2 gap-3">
						<div>
							<label class="label" for="meta-loc">Location</label>
							<input
								class="field"
								id="meta-loc"
								name="location"
								list="loc-options"
								value={sheet.lot.location}
								maxlength="60"
							/>
						</div>
						<div>
							<label class="label" for="meta-exp">Use-by date</label>
							<input
								class="field"
								id="meta-exp"
								name="expiresOn"
								type="date"
								value={sheet.lot.expiresOn ?? ''}
							/>
						</div>
					</div>
					<div>
						<label class="label" for="meta-note">Note</label>
						<input
							class="field"
							id="meta-note"
							name="note"
							value={sheet.lot.note}
							maxlength="300"
						/>
					</div>
				{/if}
			{/if}
			<datalist id="loc-options"
				>{#each data.overview.locations as loc (loc)}<option value={loc}></option>{/each}<option
					value="Fridge"
				></option><option value="Freezer"></option><option value="Cupboard"></option></datalist
			>
			<div class="flex gap-2.5">
				<button type="button" class="btn-secondary flex-1" onclick={() => (sheet = null)}
					>Cancel</button
				>
				<button
					class="{sheet.mode === 'waste' ? 'btn-danger' : 'btn-primary'} flex-[1.4]"
					disabled={sheetBusy}
					>{sheetBusy
						? 'Saving…'
						: sheet.mode === 'add'
							? 'Add'
							: sheet.mode === 'correct'
								? 'Save correction'
								: sheet.mode === 'waste'
									? 'Record waste'
									: 'Save'}</button
				>
			</div>
		</form>
	{/if}
</Sheet>

<BarcodeScanner
	bind:this={scanner}
	bind:open={scannerOpen}
	busy={looking}
	ondetected={lookUp}
	onclose={() => (scannerOpen = false)}
/>

<ScanConfirm
	{scan}
	categories={data.categories}
	operationId={scanOpId}
	onclose={() => (scan = null)}
	onresult={afterScanSave}
/>
