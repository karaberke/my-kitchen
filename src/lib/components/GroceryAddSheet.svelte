<script lang="ts">
	import { enhance } from '$app/forms';
	import Sheet from '$lib/components/Sheet.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import IngredientAutocomplete from '$lib/components/IngredientAutocomplete.svelte';
	import { pushToast } from '$lib/client/toast.svelte';
	import type { MutateEnhance } from '$lib/client/enhance';
	import { UNITS } from '$lib/shared/units';
	import { GROCERY_CATEGORIES } from '$lib/shared/grocery-categories';
	import { NOTE_MAX_CHARS } from '$lib/shared/text';
	import type { ListDetail } from '$lib/server/grocery';

	/** The "Add an item" sheet of the grocery list page. */
	let {
		open = $bindable(false),
		listStatus,
		error = '',
		mutate
	}: {
		open: boolean;
		listStatus: ListDetail['status'];
		/** The message of a failed `addLine` action. */
		error?: string;
		mutate: MutateEnhance;
	} = $props();

	let addName = $state('');
	let addIngredientId = $state<string | null>(null);
	let addLabel = $state<string | null>(null);
	let addCreate = $state(false);
</script>

<Sheet
	bind:open
	title="Add an item"
	description={listStatus === 'draft'
		? 'Manual items keep their own amount; the pantry is only subtracted if you ask for it.'
		: 'Added to the trip in progress.'}
>
	{#if error}<div class="mb-3">
			<Alert kind="error">{error}</Alert>
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
