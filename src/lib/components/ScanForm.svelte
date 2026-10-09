<script lang="ts">
	import { untrack } from 'svelte';
	import Alert from '$lib/components/Alert.svelte';
	import CategoryField from '$lib/components/CategoryField.svelte';
	import IngredientAutocomplete from '$lib/components/IngredientAutocomplete.svelte';
	import StockFields from '$lib/components/StockFields.svelte';
	import type { Scan } from '$lib/components/ScanConfirm.svelte';
	import { enhance } from '$app/forms';
	import type { ActionResult } from '@sveltejs/kit';
	import { remoteErrorMessage } from '$lib/client/remote';
	import { assistantIngredientMatch } from '$lib/remote/ingredients.remote';
	import { parseAmount } from '$lib/shared/amount-parse';
	import { pantryAmount } from '$lib/shared/package-size';
	import { unitLabel } from '$lib/shared/units';
	import { collapseSpaces } from '$lib/shared/text';

	/**
	 * The form of one scanned product. Every value starts from what the lookup
	 * suggested and is editable. ScanConfirm keys this component on the barcode,
	 * so a different barcode builds a new form.
	 */
	let {
		scan,
		categories,
		aiEnabled = false,
		operationId,
		onresult
	}: {
		scan: Scan;
		categories: readonly string[];
		/** show "Ask the assistant" beside the candidates */
		aiEnabled?: boolean;
		operationId: string;
		onresult: (result: ActionResult) => void;
	} = $props();

	/** What the form shows before the person changes anything. */
	function seed({ suggestion }: Scan) {
		const sized = {
			name: suggestion.name,
			quantity: suggestion.packageQuantity ?? '',
			unit: suggestion.packageUnit ?? '',
			packageCount: String(suggestion.packageCount)
		};
		// The household already links this barcode to an ingredient.
		if (suggestion.ingredientId)
			return {
				...sized,
				ingredientId: suggestion.ingredientId,
				identityLabel: suggestion.name,
				proposed: false
			};
		// The title names an ingredient with only harmless words around it;
		// one ✕ on the combobox removes the proposal.
		if (suggestion.proposal)
			return {
				...sized,
				ingredientId: suggestion.proposal.ingredientId,
				identityLabel: suggestion.proposal.name,
				proposed: true
			};
		return { ...sized, ingredientId: null, identityLabel: null, proposed: false };
	}
	// Read once: the page keys this component on the barcode, so `scan` never changes here.
	const initial = untrack(() => seed(scan));

	let name = $state(initial.name);
	let ingredientId = $state<string | null>(initial.ingredientId);
	let identityLabel = $state<string | null>(initial.identityLabel);
	let createIdentity = $state(false);
	let proposed = $state(initial.proposed);
	let quantity = $state(initial.quantity);
	let unit = $state(initial.unit);
	let packageCount = $state(initial.packageCount);
	let busy = $state(false);
	// The assistant's pick among the listed candidates; the user still taps to choose.
	let asking = $state(false);
	let askError = $state<string | null>(null);
	let askedPick = $state<{ id: string | null } | null>(null);

	/** Choosing a listed candidate matches `choose()` in IngredientAutocomplete: the
	 *  typed name is left as it is, only the identity link changes. */
	function chooseCandidate(c: { id: string; name: string }) {
		ingredientId = c.id;
		identityLabel = c.name;
		createIdentity = false;
		proposed = false;
	}

	async function askAssistant() {
		if (asking) return;
		// The candidates were searched with the product name, so ask about that.
		const asked = collapseSpaces(scan.suggestion.name || name);
		if (!asked) return;
		asking = true;
		askError = null;
		try {
			const { picks } = await assistantIngredientMatch({ names: [asked] });
			const pick = picks[asked];
			const listed = scan.suggestion.candidates.some((c) => c.id === pick?.id);
			askedPick = { id: pick && listed ? pick.id : null };
		} catch (err) {
			askError = remoteErrorMessage(err, 'Could not reach the server. Check your connection.');
		} finally {
			asking = false;
		}
	}

	const SOURCE_LABEL: Record<string, string> = {
		usda: 'USDA FoodData Central',
		off: 'Open Food Facts',
		household: 'Saved by your household',
		none: 'Not in any product database'
	};

	const LICENCE: Record<string, string> = {
		usda: 'Public domain (CC0).',
		off: 'Open Food Facts, under the Open Database Licence (ODbL).'
	};

	const providerSource = $derived(scan.lookup.product?.source ?? null);

	/** The amount that will actually be stored, shown before it is stored. */
	const total = $derived.by(() => {
		const parsed = parseAmount(quantity);
		if (!parsed.ok || !parsed.value) return null;
		const count = Number(packageCount);
		const result = pantryAmount({ amount: parsed.value, unit }, count);
		return result.ok ? `${result.quantity.toHuman()} ${unitLabel(unit, result.quantity)}` : null;
	});

	/** True when the household's saved size differs from the provider's. */
	const editedSize = $derived.by(() => {
		const p = scan.lookup.product;
		const link = scan.lookup.link;
		if (!p || !link || !link.defaultQuantity || !p.packageAmount) return false;
		return link.defaultQuantity !== p.packageAmount || link.defaultUnit !== p.packageUnit;
	});

	const missingSize = $derived(
		scan.suggestion.packageQuantity === null && scan.suggestion.from !== 'household'
	);

	/**
	 * Neither an ingredient nor a name the user gave for a new one — the server
	 * rejects this. The untouched product title alone never makes an identity;
	 * a typed name or the "new ingredient" choice does.
	 */
	const noIngredient = $derived(
		!ingredientId &&
			!(name.trim() && (createIdentity || name.trim() !== scan.suggestion.name.trim()))
	);
</script>

<form
	method="post"
	action="?/scanAdd"
	class="flex flex-col gap-3.5"
	use:enhance={() => {
		busy = true;
		return async ({ result, update }) => {
			busy = false;
			await update({ reset: false });
			onresult(result);
		};
	}}
>
	<input type="hidden" name="operationId" value={operationId} />
	<input type="hidden" name="code" value={scan.code} />
	{#if scan.symbology}<input type="hidden" name="symbology" value={scan.symbology} />{/if}
	<input type="hidden" name="displayName" value={scan.suggestion.name || name} />
	<input type="hidden" name="providerTitle" value={scan.suggestion.name} />
	<input type="hidden" name="brand" value={scan.suggestion.brand} />
	<input type="hidden" name="labelText" value={scan.suggestion.packageLabelText} />
	<input
		type="hidden"
		name="origin"
		value={scan.lookup.link ? scan.lookup.link.origin : (providerSource ?? 'manual')}
	/>

	<div class="card-flat px-3.5 py-3">
		<p class="text-[13.5px] font-bold">
			{scan.suggestion.name || 'Unknown product'}
			{#if scan.suggestion.brand}<span class="font-normal text-sage">
					· {scan.suggestion.brand}</span
				>{/if}
		</p>
		<p class="mt-1 text-[11.5px] text-sage">
			{scan.lookup.digits} · {SOURCE_LABEL[scan.suggestion.from] ?? scan.suggestion.from}
		</p>
		{#if scan.suggestion.packageLabelText}
			<p class="mt-1 text-[11.5px] text-sage">
				Label: {scan.suggestion.packageLabelText}
			</p>
		{/if}
		{#if scan.suggestion.from === 'household' && providerSource}
			<p class="mt-1 text-[11.5px] text-sage">
				{SOURCE_LABEL[providerSource]} also holds this product{editedSize
					? `, as ${scan.lookup.product?.packageAmount} ${scan.lookup.product?.packageUnit}. Your household's own size is kept.`
					: '.'}
			</p>
		{/if}
		{#if providerSource && LICENCE[providerSource]}
			<p class="mt-1 text-[11px] text-sage-soft">{LICENCE[providerSource]}</p>
		{/if}
	</div>

	{#if scan.lookup.outcome === 'not_found'}
		<Alert kind="info"
			>No product database holds this barcode. Name it and confirm the size, and this household will
			recognise it next time.</Alert
		>
	{:else if scan.lookup.outcome === 'unavailable'}
		<Alert kind="warn"
			>A product database could not be reached just now. You can still add this by hand, and the
			lookup is not remembered as a miss.</Alert
		>
	{:else if scan.lookup.outcome === 'no_providers'}
		<Alert kind="info"
			>No product database is switched on for this install. Name the product and it will be
			recognised next time.</Alert
		>
	{/if}

	{#if !ingredientId && !createIdentity && scan.suggestion.candidates.length}
		<fieldset>
			<legend class="label">Which ingredient is this?</legend>
			<div class="flex flex-wrap gap-2">
				{#each scan.suggestion.candidates as c (c.id)}
					<button
						type="button"
						class="btn-secondary btn-sm {askedPick?.id === c.id ? 'border-leaf bg-leaf-soft' : ''}"
						onclick={() => chooseCandidate(c)}
					>
						{c.name}{#if askedPick?.id === c.id}
							<span class="pill bg-leaf-soft text-leaf-dark">Assistant's pick</span>{/if}
					</button>
				{/each}
			</div>
			{#if aiEnabled}
				<div class="mt-2">
					<button
						type="button"
						class="btn-ghost btn-sm"
						onclick={askAssistant}
						disabled={asking}
						aria-busy={asking}
					>
						{asking ? 'Asking the assistant…' : 'Ask the assistant'}
					</button>
				</div>
				<div aria-live="polite">
					{#if asking}
						<p class="mt-1 text-[12.5px] text-sage">
							Asking the assistant… this can take a minute.
						</p>
					{/if}
					{#if askError}<Alert class="mt-2" kind="error">{askError}</Alert>{/if}
					{#if askedPick && askedPick.id === null}
						<p class="mt-1 text-[12.5px] text-sage">
							The assistant is not sure. Choose one or type a name.
						</p>
					{/if}
				</div>
			{/if}
		</fieldset>
	{/if}

	<div>
		<label class="label" for="scan-name">Ingredient</label>
		<IngredientAutocomplete
			inputId="scan-name"
			fieldName="name"
			bind:name
			bind:ingredientId
			bind:identityLabel
			bind:createIdentity
			bind:proposed
			propose
		/>
		<p class="hint">
			{#if ingredientId}
				This barcode will be remembered for this ingredient.
			{:else}
				Pick a match so this stock can be used by recipes, or create it as your own ingredient. A
				similar name alone is not enough to link two products.
			{/if}
		</p>
	</div>

	{#if !ingredientId}
		<CategoryField id="scan-category" {categories} />
	{/if}

	{#if scan.suggestion.sizeReason === 'ambiguous_oz'}
		<fieldset>
			<legend class="label">The label says OZ. Is that weight or fluid ounces?</legend>
			<div class="flex gap-2">
				<button
					type="button"
					class="btn-secondary btn-sm {unit === 'oz' ? 'border-leaf bg-leaf-soft' : ''}"
					onclick={() => (unit = 'oz')}
				>
					Weight (oz)
				</button>
				<button
					type="button"
					class="btn-secondary btn-sm {unit === 'fl_oz' ? 'border-leaf bg-leaf-soft' : ''}"
					onclick={() => (unit = 'fl_oz')}
				>
					Fluid ounces (fl oz)
				</button>
			</div>
		</fieldset>
	{/if}

	{#if missingSize}
		<Alert kind="info"
			>No package size was available for this barcode, so type what one package holds. A serving
			size is not a package size.</Alert
		>
	{/if}

	<StockFields
		idPrefix="scan"
		bind:quantity
		bind:unit
		quantityName="packageQuantity"
		quantityLabel="One package holds"
		quantityPlaceholder="500"
		quantityRequired
		unitPlaceholder="Select a unit"
		locationPlaceholder="Pantry"
		expiresHint="A barcode cannot say when this package expires."
	>
		<div>
			<label class="label" for="scan-count">Packages bought</label>
			<input
				class="field"
				id="scan-count"
				name="packageCount"
				inputmode="numeric"
				required
				bind:value={packageCount}
			/>
		</div>
		<div>
			<span class="label">Goes into the pantry</span>
			<p class="mt-2 text-[15px] font-bold" data-testid="scan-total">{total ?? '—'}</p>
		</div>
	</StockFields>

	<div>
		<label class="label" for="scan-note">Note</label>
		<input class="field" id="scan-note" name="note" placeholder="Optional" />
	</div>

	<button class="btn btn-primary" type="submit" disabled={busy || !total || noIngredient}>
		{busy ? 'Adding…' : 'Add to pantry'}
	</button>
</form>
