<script lang="ts">
	import { enhance } from '$app/forms';
	import Sheet from '$lib/components/Sheet.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import IngredientAutocomplete from '$lib/components/IngredientAutocomplete.svelte';
	import StockFields from '$lib/components/StockFields.svelte';
	import type { MutateEnhance } from '$lib/client/enhance';
	import type { LineView } from '$lib/server/grocery';

	/** The "Confirm what you bought" sheet of the grocery list page; open while `line` is set. */
	let {
		line,
		lineAmount,
		operationId,
		error = '',
		mutate,
		onclose
	}: {
		line: LineView | null;
		/** How the list shows the amount of a line. */
		lineAmount: (line: LineView) => string;
		operationId: string;
		/** The message of a failed `purchase` action. */
		error?: string;
		mutate: MutateEnhance;
		onclose: () => void;
	} = $props();

	let buyUnit = $state('g');
	let buyName = $state('');
	let buyIngredientId = $state<string | null>(null);
	let buyLabel = $state<string | null>(null);
	let buyCreate = $state(false);
	// Start each purchase from its own line, before the sheet renders.
	$effect.pre(() => {
		if (!line) return;
		buyUnit = line.unit ?? 'piece';
		buyName = line.name;
		buyIngredientId = line.ingredientId;
		buyLabel = line.ingredientId ? line.name : null;
		buyCreate = false;
	});
</script>

<Sheet
	open={!!line}
	{onclose}
	title="Confirm what you bought"
	description={line
		? `${line.name} · list asks for ${lineAmount(line)}. Packages rarely match, so enter the real amount; all of it goes into the pantry.`
		: ''}
>
	{#if line}
		{#if error}<div class="mb-3">
				<Alert kind="error">{error}</Alert>
			</div>{/if}
		<form method="post" action="?/purchase" class="flex flex-col gap-3.5" use:enhance={mutate()}>
			<input type="hidden" name="operationId" value={operationId} />
			<input type="hidden" name="lineId" value={line.id} />
			<StockFields
				idPrefix="buy"
				bind:unit={buyUnit}
				quantityLabel="Amount bought"
				quantityPlaceholder="e.g. 1000 for a 1 kg bag"
				locationLabel="Where it goes"
				locationPlaceholder="Fridge, Cupboard"
			/>
			{#if !line.ingredientId}
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
			{#if line.unit && buyUnit && line.unit !== buyUnit}
				<p class="text-[12px] text-honey-dark">
					Different unit from the list ({line.unit}). It is credited when convertible; otherwise the
					line is marked handled and the pantry still gets the full amount.
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
