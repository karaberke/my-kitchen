<script lang="ts">
	import { enhance } from '$app/forms';
	import Sheet from '$lib/components/Sheet.svelte';
	import CategoryField from '$lib/components/CategoryField.svelte';
	import type { MutateEnhance } from '$lib/client/enhance';
	import { GROCERY_CATEGORIES } from '$lib/shared/grocery-categories';
	import { NOTE_MAX_CHARS } from '$lib/shared/text';
	import type { LineView, ListDetail } from '$lib/server/grocery';

	/** The "Edit line" sheet of the grocery list page; open while `line` is set. */
	let {
		line,
		listStatus,
		mutate,
		onclose
	}: {
		line: LineView | null;
		listStatus: ListDetail['status'];
		mutate: MutateEnhance;
		onclose: () => void;
	} = $props();
</script>

<Sheet
	open={!!line}
	{onclose}
	title="Edit line"
	description={line
		? listStatus === 'draft'
			? line.kind === 'manual'
				? 'Change the requested amount, category or note.'
				: 'Recipe amounts come from the plan; change servings on the batch instead. You can change category and note.'
			: 'Editing the remaining target keeps the credited purchases; the total target is adjusted consistently.'
		: ''}
>
	{#if line}
		<form
			method="post"
			action="?/line"
			class="flex flex-col gap-3.5"
			use:enhance={mutate({ reloadOnFailure: true })}
		>
			<input type="hidden" name="lineId" value={line.id} />
			<input type="hidden" name="expectedRevision" value={line.revision} />
			{#if listStatus === 'shopping' || line.kind === 'manual'}
				<div>
					<label class="label" for="edit-amount"
						>{listStatus === 'draft' ? 'Requested amount' : 'Remaining to buy'}
						{line.unit ? `(${line.unit})` : ''}</label
					>
					<input
						class="field"
						id="edit-amount"
						name="amount"
						inputmode="decimal"
						value={listStatus === 'draft' ? (line.demandAmount ?? '') : (line.remaining ?? '')}
					/>
					{#if listStatus === 'shopping' && line.kind === 'recipe'}<p class="hint">
							Recipe-derived targets are never recalculated automatically; this is a deliberate
							override.
						</p>{/if}
				</div>
			{/if}
			<div class="grid grid-cols-2 gap-3">
				<CategoryField
					id="edit-category"
					categories={GROCERY_CATEGORIES}
					label="Category"
					value={line.category}
				/>
				<div>
					<label class="label" for="edit-note">Note</label>
					<input
						class="field"
						id="edit-note"
						name="note"
						value={line.note}
						maxlength={NOTE_MAX_CHARS}
					/>
				</div>
			</div>
			<div class="flex flex-wrap gap-2.5">
				<button class="btn-primary flex-1">Save</button>
				{#if listStatus === 'shopping' && line.status === 'pending'}
					<button class="btn-secondary" name="status" value="handled">Mark handled</button>
				{:else if listStatus === 'shopping' && line.status === 'handled'}
					<button class="btn-secondary" name="status" value="pending">Back to pending</button>
				{/if}
				{#if line.kind === 'manual' && line.purchasedAmount === '0'}
					<button class="btn-danger" name="remove" value="1">Remove</button>
				{/if}
			</div>
		</form>
	{/if}
</Sheet>
