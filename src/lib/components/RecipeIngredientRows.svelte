<script lang="ts" module>
	import type { RecipeFormInput } from '$lib/shared/recipe-input';

	export interface IngredientRow {
		key: number;
		name: string;
		ingredientId: string | null;
		identityLabel: string | null;
		createIdentity: boolean;
		proposed: boolean;
		amount: string;
		unit: string;
		preparation: string;
		group: string;
		optional: boolean;
	}

	let seq = 0;
	/** A row from stored recipe data; `identityLabels` names the linked ingredients. */
	export const rowFrom = (
		i: RecipeFormInput['ingredients'][number] & { createIdentity?: boolean },
		identityLabels: Record<string, string>
	): IngredientRow => ({
		key: ++seq,
		name: i.name,
		ingredientId: i.ingredientId,
		identityLabel: i.ingredientId ? (identityLabels[i.ingredientId] ?? i.name) : null,
		createIdentity: !!i.createIdentity,
		proposed: !!i.proposed,
		amount: i.amount,
		unit: i.unit,
		preparation: i.preparation,
		group: i.group,
		optional: i.optional
	});
	export const blankIngredient = (group = ''): IngredientRow => ({
		key: ++seq,
		name: '',
		ingredientId: null,
		identityLabel: null,
		createIdentity: false,
		proposed: false,
		amount: '',
		unit: '',
		preparation: '',
		group,
		optional: false
	});
</script>

<script lang="ts">
	import IngredientAutocomplete from './IngredientAutocomplete.svelte';
	import Alert from './Alert.svelte';
	import { parseAmount } from '$lib/shared/amount-parse';
	import { UNITS, normalizeUnitInput } from '$lib/shared/units';
	import { focusRow, move } from '$lib/client/rows';
	import type { FieldErrors } from '$lib/shared/recipe-input';

	/**
	 * The ingredient rows of the recipe form: fields, add, remove, move and drag.
	 * `onsettle` tells the form that the rows changed shape, so it compares for real.
	 */
	let {
		rows = $bindable(),
		errors,
		onsettle
	}: {
		rows: IngredientRow[];
		errors: FieldErrors;
		onsettle: () => void;
	} = $props();

	let amountErrors = $state<Record<number, string>>({});

	function addIngredient(after?: number) {
		const idx = after === undefined ? rows.length : after + 1;
		const group = rows[after ?? rows.length - 1]?.group ?? '';
		rows = [...rows.slice(0, idx), blankIngredient(group), ...rows.slice(idx)];
		focusRow('ing', idx, 'amount');
		onsettle();
	}
	function removeIngredient(i: number) {
		rows = rows.filter((_, idx) => idx !== i);
		if (!rows.length) rows = [blankIngredient()];
		focusRow('ing', Math.max(0, i - 1), 'name');
		onsettle();
	}
	function moveIngredient(from: number, to: number) {
		rows = move(rows, from, to);
		onsettle();
	}
	function checkAmount(i: number) {
		const r = parseAmount(rows[i].amount);
		amountErrors[i] = r.ok ? '' : r.error;
	}
	function normaliseUnit(i: number) {
		const raw = rows[i].unit.trim();
		if (!raw) return;
		const norm = normalizeUnitInput(raw);
		if (norm) rows[i].unit = norm;
	}

	// Drag & drop (pointer) — keyboard users have the up/down buttons.
	let dragging = $state<number | null>(null);
	function onDrop(index: number) {
		if (dragging === null) return;
		moveIngredient(dragging, index);
		dragging = null;
	}
	const unitOptions = UNITS.map((u) => ({
		id: u.id,
		label: u.plural === u.singular ? u.singular : `${u.singular} / ${u.plural}`
	}));
</script>

<section>
	<div class="mb-2 flex items-end justify-between">
		<h2 class="text-[17px]">Ingredients</h2>
		<span class="text-[11.5px] text-sage"
			>Amounts like 2, 1.5, 1/2 or 1 ½ · leave empty for “to taste”</span
		>
	</div>
	{#if errors.ingredients}<div class="mb-2">
			<Alert kind="error">{errors.ingredients}</Alert>
		</div>{/if}
	<ol class="flex flex-col gap-2.5">
		{#each rows as row, i (row.key)}
			<li
				class="card p-3 {dragging === i ? 'opacity-50' : ''}"
				ondragover={(e) => {
					if (dragging !== null) e.preventDefault();
				}}
				ondrop={(e) => {
					e.preventDefault();
					onDrop(i);
				}}
			>
				<div class="flex items-start gap-2">
					<button
						type="button"
						class="icon-btn mt-6 cursor-grab touch-none"
						draggable="true"
						ondragstart={() => (dragging = i)}
						ondragend={() => (dragging = null)}
						aria-label="Drag to reorder ingredient {i + 1}"
						title="Drag to reorder">⋮⋮</button
					>
					<div class="grid min-w-0 flex-1 gap-2 sm:grid-cols-[1fr_1fr_1.6fr]">
						<div>
							<label class="label" for="ing-{i}-amount">Amount</label>
							<input
								class="field {errors[`ing.${i}.amount`] || amountErrors[i] ? 'field-error' : ''}"
								id="ing-{i}-amount"
								name="ing.{i}.amount"
								bind:value={row.amount}
								inputmode="decimal"
								placeholder="500"
								onblur={() => checkAmount(i)}
								aria-invalid={!!(errors[`ing.${i}.amount`] || amountErrors[i])}
							/>
							{#if errors[`ing.${i}.amount`] || amountErrors[i]}<p class="error-text">
									{errors[`ing.${i}.amount`] ?? amountErrors[i]}
								</p>{/if}
						</div>
						<div>
							<label class="label" for="ing-{i}-unit">Unit</label>
							<input
								class="field {errors[`ing.${i}.unit`] ? 'field-error' : ''}"
								id="ing-{i}-unit"
								name="ing.{i}.unit"
								bind:value={row.unit}
								list="unit-options"
								placeholder="g"
								onblur={() => normaliseUnit(i)}
								aria-invalid={!!errors[`ing.${i}.unit`]}
							/>
							{#if errors[`ing.${i}.unit`]}<p class="error-text">
									{errors[`ing.${i}.unit`]}
								</p>{/if}
						</div>
						<div>
							<label class="label" for="ing-{i}-name">Ingredient</label>
							<IngredientAutocomplete
								inputId="ing-{i}-name"
								fieldName="ing.{i}.name"
								bind:name={row.name}
								bind:ingredientId={row.ingredientId}
								bind:identityLabel={row.identityLabel}
								bind:createIdentity={row.createIdentity}
								bind:proposed={row.proposed}
								propose
								onenter={() => focusRow('ing', i, 'preparation')}
							/>
							{#if errors[`ing.${i}.name`]}<p class="error-text">
									{errors[`ing.${i}.name`]}
								</p>{/if}
						</div>
						<div class="sm:col-span-2">
							<label class="label" for="ing-{i}-preparation">Preparation / original wording</label>
							<input
								class="field"
								id="ing-{i}-preparation"
								name="ing.{i}.preparation"
								bind:value={row.preparation}
								placeholder="diced, or “1 can (400 ml)”"
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										addIngredient(i);
									}
								}}
							/>
						</div>
						<div class="flex flex-col gap-1">
							<label class="label" for="ing-{i}-group"
								>Group <span class="font-normal text-sage">(optional)</span></label
							>
							<input
								class="field"
								id="ing-{i}-group"
								name="ing.{i}.group"
								bind:value={row.group}
								placeholder="Dough, Topping…"
								list="group-options"
							/>
						</div>
					</div>
				</div>
				<div class="mt-2 flex flex-wrap items-center gap-2 pl-11">
					<label class="flex min-h-9 items-center gap-2 text-[12.5px]"
						><input
							type="checkbox"
							name="ing.{i}.optional"
							bind:checked={row.optional}
							class="h-4 w-4 accent-leaf"
						/> Optional</label
					>
					<span class="flex-1"></span>
					<button
						type="button"
						class="icon-btn"
						onclick={() => moveIngredient(i, i - 1)}
						disabled={i === 0}
						aria-label="Move ingredient {i + 1} up">↑</button
					>
					<button
						type="button"
						class="icon-btn"
						onclick={() => moveIngredient(i, i + 1)}
						disabled={i === rows.length - 1}
						aria-label="Move ingredient {i + 1} down">↓</button
					>
					<button
						type="button"
						class="icon-btn text-brick-dark"
						onclick={() => removeIngredient(i)}
						aria-label="Remove ingredient {i + 1}">✕</button
					>
				</div>
			</li>
		{/each}
	</ol>
	<button type="button" class="btn-secondary btn-sm mt-2.5" onclick={() => addIngredient()}
		>+ Add ingredient</button
	>
	<datalist id="unit-options"
		>{#each unitOptions as u (u.id)}<option value={u.id}>{u.label}</option>{/each}</datalist
	>
	<datalist id="group-options"
		>{#each [...new Set(rows.map((r) => r.group).filter(Boolean))] as g (g)}<option value={g}
			></option>{/each}</datalist
	>
</section>
