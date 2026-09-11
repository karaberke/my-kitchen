<script lang="ts">
	import Sheet from '$lib/components/Sheet.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import IngredientAutocomplete from '$lib/components/IngredientAutocomplete.svelte';
	import { enhance } from '$app/forms';
	import { parseAmount } from '$lib/shared/amount-parse';
	import { pantryAmount } from '$lib/shared/package-size';
	import { UNITS, unitLabel } from '$lib/shared/units';
	import type { BarcodeLookup } from '$lib/server/barcode/lookup';
	import type { ScanSuggestion } from '$lib/server/barcode/suggest';

	/**
	 * Confirm a scanned product before anything is stored.
	 *
	 * Every value is editable, and nothing reaches the pantry until Add is
	 * pressed. Where a value came from is shown beside it, so a household's own
	 * correction is never confused with what a provider said.
	 */
	export interface Scan {
		code: string;
		symbology: string | null;
		lookup: BarcodeLookup;
		suggestion: ScanSuggestion;
	}

	let {
		scan,
		categories,
		operationId,
		onclose,
		onresult
	}: {
		scan: Scan | null;
		categories: readonly string[];
		operationId: string;
		onclose: () => void;
		onresult: (result: { type: string; data?: Record<string, unknown> }) => void;
	} = $props();

	let name = $state('');
	let ingredientId = $state<string | null>(null);
	let identityLabel = $state<string | null>(null);
	let createIdentity = $state(false);
	let quantity = $state('');
	let unit = $state('g');
	let packageCount = $state('1');
	let busy = $state(false);
	let seen = $state('');

	// Re-seed the form each time a different barcode arrives.
	$effect(() => {
		if (!scan || seen === scan.lookup.gtin + scan.suggestion.from) return;
		seen = scan.lookup.gtin + scan.suggestion.from;
		name = scan.suggestion.name;
		ingredientId = scan.suggestion.ingredientId;
		identityLabel = scan.suggestion.ingredientId ? scan.suggestion.name : null;
		createIdentity = !scan.suggestion.ingredientId && !!scan.suggestion.name;
		quantity = scan.suggestion.packageQuantity ?? '';
		unit = scan.suggestion.packageUnit ?? 'g';
		packageCount = String(scan.suggestion.packageCount);
	});

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

	const providerSource = $derived(scan?.lookup.product?.source ?? null);

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
		const p = scan?.lookup.product;
		const link = scan?.lookup.link;
		if (!p || !link || !link.defaultQuantity || !p.packageAmount) return false;
		return link.defaultQuantity !== p.packageAmount || link.defaultUnit !== p.packageUnit;
	});

	const missingSize = $derived(
		!!scan && scan.suggestion.packageQuantity === null && scan.suggestion.from !== 'household'
	);
</script>

<Sheet
	open={!!scan}
	{onclose}
	title={scan?.lookup.outcome === 'known' ? 'Add this again' : 'Confirm this product'}
	description="Nothing is stored until you press Add to pantry."
>
	{#if scan}
		<form
			method="post"
			action="?/scanAdd"
			class="flex flex-col gap-3.5"
			use:enhance={() => {
				busy = true;
				return async ({ result, update }) => {
					busy = false;
					await update({ reset: false });
					onresult(result as never);
				};
			}}
		>
			<input type="hidden" name="operationId" value={operationId} />
			<input type="hidden" name="code" value={scan.code} />
			{#if scan.symbology}<input type="hidden" name="symbology" value={scan.symbology} />{/if}
			<input type="hidden" name="displayName" value={scan.suggestion.name || name} />
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
					>No product database holds this barcode. Name it and confirm the size, and this household
					will recognise it next time.</Alert
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

			<div>
				<label class="label" for="scan-name">Ingredient</label>
				<IngredientAutocomplete
					inputId="scan-name"
					fieldName="name"
					bind:name
					bind:ingredientId
					bind:identityLabel
					bind:createIdentity
				/>
				<p class="hint">
					{#if ingredientId}
						This barcode will be remembered for this ingredient.
					{:else}
						Pick a match so this stock can be used by recipes, or create it as your own ingredient.
						A similar name alone is not enough to link two products.
					{/if}
				</p>
			</div>

			{#if !ingredientId}
				<div>
					<label class="label" for="scan-category">Category (for new ingredients)</label>
					<select class="field" id="scan-category" name="category"
						>{#each categories as c (c)}<option value={c}>{c}</option>{/each}</select
					>
				</div>
			{/if}

			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="label" for="scan-qty">One package holds</label>
					<input
						class="field"
						id="scan-qty"
						name="packageQuantity"
						inputmode="decimal"
						required
						placeholder="500"
						bind:value={quantity}
					/>
				</div>
				<div>
					<label class="label" for="scan-unit">Unit</label>
					<select class="field" id="scan-unit" name="unit" bind:value={unit}
						>{#each UNITS as u (u.id)}<option value={u.id}
								>{u.singular}{u.plural !== u.singular ? ` / ${u.plural}` : ''}</option
							>{/each}</select
					>
				</div>
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
			</div>

			{#if missingSize}
				<Alert kind="info"
					>No package size was available for this barcode, so type what one package holds. A serving
					size is not a package size.</Alert
				>
			{/if}

			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="label" for="scan-loc">Location</label>
					<input class="field" id="scan-loc" name="location" placeholder="Pantry" />
				</div>
				<div>
					<label class="label" for="scan-date">Use by</label>
					<input class="field" id="scan-date" name="expiresOn" type="date" />
					<p class="hint">A barcode cannot say when this package expires.</p>
				</div>
			</div>

			<div>
				<label class="label" for="scan-note">Note</label>
				<input class="field" id="scan-note" name="note" placeholder="Optional" />
			</div>

			<button class="btn btn-primary" type="submit" disabled={busy || !total}>
				{busy ? 'Adding…' : 'Add to pantry'}
			</button>
		</form>
	{/if}
</Sheet>
