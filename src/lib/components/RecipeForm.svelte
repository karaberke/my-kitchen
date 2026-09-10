<script lang="ts">
	import { enhance } from '$app/forms';
	import { beforeNavigate } from '$app/navigation';
	import IngredientAutocomplete from './IngredientAutocomplete.svelte';
	import Alert from './Alert.svelte';
	import { parseAmount } from '$lib/shared/amount-parse';
	import { UNITS, normalizeUnitInput } from '$lib/shared/units';
	import { resizeForUpload } from '$lib/client/image-resize';
	import {
		parseRecipeForm,
		validateRecipe,
		type FieldErrors,
		type RecipeFormInput
	} from '$lib/shared/recipe-input';

	interface IngredientRow {
		key: number;
		name: string;
		ingredientId: string | null;
		identityLabel: string | null;
		createIdentity: boolean;
		amount: string;
		unit: string;
		preparation: string;
		group: string;
		optional: boolean;
	}
	interface StepRow {
		key: number;
		section: string;
		text: string;
	}

	let {
		initial,
		identityLabels = {},
		errors: serverErrors = {},
		message: serverMessage = '',
		conflict = false,
		mode,
		expectedRevision = null,
		image = null,
		action = ''
	}: {
		initial: RecipeFormInput;
		identityLabels?: Record<string, string>;
		errors?: FieldErrors;
		message?: string;
		conflict?: boolean;
		mode: 'new' | 'edit';
		expectedRevision?: number | null;
		image?: { id: string; version: number } | null;
		action?: string;
	} = $props();

	let seq = 0;
	const rowFrom = (
		i: RecipeFormInput['ingredients'][number] & { createIdentity?: boolean }
	): IngredientRow => ({
		key: ++seq,
		name: i.name,
		ingredientId: i.ingredientId,
		identityLabel: i.ingredientId ? (identityLabels[i.ingredientId] ?? i.name) : null,
		createIdentity: !!i.createIdentity,
		amount: i.amount,
		unit: i.unit,
		preparation: i.preparation,
		group: i.group,
		optional: i.optional
	});
	const blankIng = (group = ''): IngredientRow => ({
		key: ++seq,
		name: '',
		ingredientId: null,
		identityLabel: null,
		createIdentity: false,
		amount: '',
		unit: '',
		preparation: '',
		group,
		optional: false
	});
	const blankStep = (section = ''): StepRow => ({ key: ++seq, section, text: '' });

	/* The form owns its state after mount; parents remount it with {#key} when initial changes. */
	/* svelte-ignore state_referenced_locally */
	let title = $state(initial.title);
	let description = $state(initial.description);
	let baseServings = $state(initial.baseServings);
	let yieldNote = $state(initial.yieldNote);
	let prepMinutes = $state(initial.prepMinutes);
	let cookMinutes = $state(initial.cookMinutes);
	let source = $state(initial.source);
	let notes = $state(initial.notes);
	let tags = $state(initial.tags);
	let convention = $state(initial.convention || 'metric');
	let ingredients = $state<IngredientRow[]>(
		initial.ingredients.length ? initial.ingredients.map(rowFrom) : [blankIng()]
	);
	let steps = $state<StepRow[]>(
		initial.steps.length ? initial.steps.map((s) => ({ key: ++seq, ...s })) : [blankStep()]
	);
	/**
	 * Problems found in the browser before submitting. Merged over whatever the
	 * server last said, so the markup below reads `errors` either way.
	 */
	let clientErrors = $state<FieldErrors>({});
	let clientMessage = $state('');
	const errors = $derived<FieldErrors>({ ...serverErrors, ...clientErrors });
	const message = $derived(clientMessage || serverMessage);

	let removeImage = $state(false);
	let imagePreview = $state<string | null>(null);
	let submitting = $state(false);
	let amountErrors = $state<Record<number, string>>({});

	const snapshot = () =>
		JSON.stringify({
			title,
			description,
			baseServings,
			yieldNote,
			prepMinutes,
			cookMinutes,
			source,
			notes,
			tags,
			convention,
			ingredients: ingredients.map((r) => ({ ...r, key: 0 })),
			steps: steps.map((s) => ({ ...s, key: 0 })),
			removeImage
		});
	const initialSnapshot = snapshot();
	const dirty = $derived(snapshot() !== initialSnapshot);

	beforeNavigate((nav) => {
		if (
			dirty &&
			!submitting &&
			!nav.willUnload &&
			!confirm('You have unsaved changes. Leave without saving?')
		)
			nav.cancel();
	});
	function onBeforeUnload(e: BeforeUnloadEvent) {
		if (dirty && !submitting) e.preventDefault();
	}

	function move<T>(list: T[], from: number, to: number): T[] {
		if (to < 0 || to >= list.length || from === to) return list;
		const copy = [...list];
		const [item] = copy.splice(from, 1);
		copy.splice(to, 0, item);
		return copy;
	}
	function focusRow(prefix: string, index: number, field: string) {
		queueMicrotask(() => document.getElementById(`${prefix}-${index}-${field}`)?.focus());
	}
	function addIngredient(after?: number) {
		const idx = after === undefined ? ingredients.length : after + 1;
		const group = ingredients[after ?? ingredients.length - 1]?.group ?? '';
		ingredients = [...ingredients.slice(0, idx), blankIng(group), ...ingredients.slice(idx)];
		focusRow('ing', idx, 'amount');
	}
	function removeIngredient(i: number) {
		ingredients = ingredients.filter((_, idx) => idx !== i);
		if (!ingredients.length) ingredients = [blankIng()];
		focusRow('ing', Math.max(0, i - 1), 'name');
	}
	function addStep(after?: number) {
		const idx = after === undefined ? steps.length : after + 1;
		steps = [
			...steps.slice(0, idx),
			blankStep(steps[after ?? steps.length - 1]?.section ?? ''),
			...steps.slice(idx)
		];
		focusRow('step', idx, 'text');
	}
	function removeStep(i: number) {
		steps = steps.filter((_, idx) => idx !== i);
		if (!steps.length) steps = [blankStep()];
	}
	function checkAmount(i: number) {
		const r = parseAmount(ingredients[i].amount);
		amountErrors[i] = r.ok ? '' : r.error;
	}
	function normaliseUnit(i: number) {
		const raw = ingredients[i].unit.trim();
		if (!raw) return;
		const norm = normalizeUnitInput(raw);
		if (norm) ingredients[i].unit = norm;
	}

	// Drag & drop (pointer) — keyboard users have the up/down buttons.
	let dragging = $state<{ list: 'ing' | 'step'; index: number } | null>(null);
	function onDrop(list: 'ing' | 'step', index: number) {
		if (!dragging || dragging.list !== list) return;
		if (list === 'ing') ingredients = move(ingredients, dragging.index, index);
		else steps = move(steps, dragging.index, index);
		dragging = null;
	}
	function onFile(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (imagePreview) URL.revokeObjectURL(imagePreview);
		imagePreview = file ? URL.createObjectURL(file) : null;
		if (file) removeImage = false;
	}
	const unitOptions = UNITS.map((u) => ({
		id: u.id,
		label: u.plural === u.singular ? u.singular : `${u.singular} / ${u.plural}`
	}));
</script>

<svelte:window onbeforeunload={onBeforeUnload} />

<form
	method="post"
	{action}
	enctype="multipart/form-data"
	class="flex flex-col gap-6"
	use:enhance={async ({ formData, cancel }) => {
		// The very rules the server applies, run here first: a missing title or
		// servings needs no round trip. The server still validates on arrival, so
		// the two cannot drift — this is the same function, not a copy of it.
		const validation = validateRecipe(parseRecipeForm(formData));
		if (!validation.ok) {
			clientErrors = validation.errors;
			clientMessage = 'Please fix the highlighted fields.';
			cancel();
			return;
		}
		clientErrors = {};
		clientMessage = '';
		submitting = true;
		// Shrink the photo here rather than shipping a 4 MB original for the server to
		// throw away. resizeForUpload returns the original on any failure, and the
		// server re-decodes and re-validates whatever arrives regardless.
		const picked = formData.get('image');
		if (picked instanceof File && picked.size > 0)
			formData.set('image', await resizeForUpload(picked));
		return async ({ result, update }) => {
			submitting = false;
			if (result.type === 'redirect') submitting = true;
			await update({ reset: false });
		};
	}}
>
	{#if expectedRevision !== null}<input
			type="hidden"
			name="expectedRevision"
			value={expectedRevision}
		/>{/if}

	{#if conflict}
		<Alert kind="error"
			>{message}
			<a
				class="font-bold underline"
				href={typeof window !== 'undefined' ? window.location.pathname : ''}
				data-sveltekit-reload>Reload the latest version</a
			> — your input here stays until you leave.</Alert
		>
	{:else if message}
		<Alert kind="error">{message}</Alert>
	{/if}

	<section class="card p-4 sm:p-5">
		<div class="grid gap-4 sm:grid-cols-2">
			<div class="sm:col-span-2">
				<label class="label" for="title">Title</label>
				<input
					class="field {errors.title ? 'field-error' : ''}"
					id="title"
					name="title"
					bind:value={title}
					placeholder="Charred broccoli with anchovy butter"
					maxlength="200"
					aria-invalid={!!errors.title}
					aria-describedby={errors.title ? 'title-error' : undefined}
				/>
				{#if errors.title}<p class="error-text" id="title-error">{errors.title}</p>{/if}
			</div>
			<div class="sm:col-span-2">
				<label class="label" for="description"
					>Description <span class="font-normal text-sage">(optional)</span></label
				>
				<textarea
					class="field min-h-20"
					id="description"
					name="description"
					bind:value={description}
					maxlength="4000"
					placeholder="What makes it good, when to cook it"></textarea>
			</div>
			<div>
				<label class="label" for="baseServings">Base servings</label>
				<input
					class="field {errors.baseServings ? 'field-error' : ''}"
					id="baseServings"
					name="baseServings"
					bind:value={baseServings}
					inputmode="decimal"
					placeholder="4"
					aria-invalid={!!errors.baseServings}
				/>
				{#if errors.baseServings}<p class="error-text">{errors.baseServings}</p>{:else}<p
						class="hint"
					>
						Quantities below are for this many servings. Scaling never changes them.
					</p>{/if}
			</div>
			<div>
				<label class="label" for="yieldNote"
					>Yield note <span class="font-normal text-sage">(optional)</span></label
				>
				<input
					class="field"
					id="yieldNote"
					name="yieldNote"
					bind:value={yieldNote}
					placeholder="One 9×13 pan"
					maxlength="200"
				/>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="label" for="prepMinutes">Prep (min)</label>
					<input
						class="field {errors.prepMinutes ? 'field-error' : ''}"
						id="prepMinutes"
						name="prepMinutes"
						bind:value={prepMinutes}
						inputmode="numeric"
						placeholder="15"
					/>
					{#if errors.prepMinutes}<p class="error-text">{errors.prepMinutes}</p>{/if}
				</div>
				<div>
					<label class="label" for="cookMinutes">Cook (min)</label>
					<input
						class="field {errors.cookMinutes ? 'field-error' : ''}"
						id="cookMinutes"
						name="cookMinutes"
						bind:value={cookMinutes}
						inputmode="numeric"
						placeholder="40"
					/>
					{#if errors.cookMinutes}<p class="error-text">{errors.cookMinutes}</p>{/if}
				</div>
			</div>
			<div>
				<label class="label" for="convention">Measuring convention</label>
				<select class="field" id="convention" name="convention" bind:value={convention}>
					<option value="metric">Metric cups &amp; spoons (250 ml cup, 15 ml tbsp)</option>
					<option value="us">US customary (236.6 ml cup, 14.8 ml tbsp)</option>
				</select>
			</div>
			<div class="sm:col-span-2">
				<label class="label" for="tags"
					>Tags <span class="font-normal text-sage">(comma separated)</span></label
				>
				<input
					class="field"
					id="tags"
					name="tags"
					bind:value={tags}
					placeholder="weeknight, vegetarian"
					maxlength="500"
				/>
			</div>
			<div class="sm:col-span-2">
				<label class="label" for="image"
					>Photo <span class="font-normal text-sage">(optional, JPEG/PNG/WebP up to 5 MB)</span
					></label
				>
				<div class="flex items-center gap-3">
					{#if imagePreview}
						<img src={imagePreview} alt="" class="h-16 w-16 rounded-[12px] object-cover" />
					{:else if image && !removeImage}
						<img
							src="/media/{image.id}/thumb?v={image.version}"
							alt=""
							class="h-16 w-16 rounded-[12px] object-cover"
						/>
					{/if}
					<input
						class="block text-[13px] file:mr-3 file:rounded-[11px] file:border-0 file:bg-linen file:px-3 file:py-2 file:font-bold"
						id="image"
						name="image"
						type="file"
						accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
						onchange={onFile}
					/>
				</div>
				{#if errors.image}<p class="error-text">{errors.image}</p>{/if}
				{#if image}
					<label class="mt-2 flex items-center gap-2 text-[13px]"
						><input
							type="checkbox"
							name="removeImage"
							bind:checked={removeImage}
							class="h-4 w-4 accent-leaf"
						/> Remove current photo</label
					>
				{/if}
			</div>
		</div>
	</section>

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
			{#each ingredients as row, i (row.key)}
				<li
					class="card p-3 {dragging?.list === 'ing' && dragging.index === i ? 'opacity-50' : ''}"
					ondragover={(e) => {
						if (dragging?.list === 'ing') e.preventDefault();
					}}
					ondrop={(e) => {
						e.preventDefault();
						onDrop('ing', i);
					}}
				>
					<div class="flex items-start gap-2">
						<button
							type="button"
							class="icon-btn mt-6 cursor-grab touch-none"
							draggable="true"
							ondragstart={() => (dragging = { list: 'ing', index: i })}
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
									onenter={() => focusRow('ing', i, 'preparation')}
								/>
								{#if errors[`ing.${i}.name`]}<p class="error-text">
										{errors[`ing.${i}.name`]}
									</p>{/if}
							</div>
							<div class="sm:col-span-2">
								<label class="label" for="ing-{i}-preparation">Preparation / original wording</label
								>
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
							onclick={() => (ingredients = move(ingredients, i, i - 1))}
							disabled={i === 0}
							aria-label="Move ingredient {i + 1} up">↑</button
						>
						<button
							type="button"
							class="icon-btn"
							onclick={() => (ingredients = move(ingredients, i, i + 1))}
							disabled={i === ingredients.length - 1}
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
			>{#each [...new Set(ingredients.map((r) => r.group).filter(Boolean))] as g (g)}<option
					value={g}
				></option>{/each}</datalist
		>
	</section>

	<section>
		<div class="mb-2 flex items-end justify-between">
			<h2 class="text-[17px]">Steps</h2>
			<span class="text-[11.5px] text-sage"
				>Optional section titles group steps (“Night before”, “Baking day”)</span
			>
		</div>
		{#if errors.steps}<div class="mb-2"><Alert kind="error">{errors.steps}</Alert></div>{/if}
		<ol class="flex flex-col gap-2.5">
			{#each steps as step, i (step.key)}
				<li
					class="card p-3 {dragging?.list === 'step' && dragging.index === i ? 'opacity-50' : ''}"
					ondragover={(e) => {
						if (dragging?.list === 'step') e.preventDefault();
					}}
					ondrop={(e) => {
						e.preventDefault();
						onDrop('step', i);
					}}
				>
					<div class="flex items-start gap-2">
						<button
							type="button"
							class="icon-btn mt-6 cursor-grab touch-none"
							draggable="true"
							ondragstart={() => (dragging = { list: 'step', index: i })}
							ondragend={() => (dragging = null)}
							aria-label="Drag to reorder step {i + 1}"
							title="Drag to reorder">⋮⋮</button
						>
						<div class="grid min-w-0 flex-1 gap-2 sm:grid-cols-[1fr_3fr]">
							<div>
								<label class="label" for="step-{i}-section"
									>Section <span class="font-normal text-sage">(optional)</span></label
								>
								<input
									class="field"
									id="step-{i}-section"
									name="step.{i}.section"
									bind:value={step.section}
									placeholder="Baking day"
								/>
							</div>
							<div>
								<label class="label" for="step-{i}-text">Step {i + 1}</label>
								<textarea
									class="field min-h-20"
									id="step-{i}-text"
									name="step.{i}.text"
									bind:value={step.text}
									placeholder="Heat the oven to 220°C…"
									onkeydown={(e) => {
										if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
											e.preventDefault();
											addStep(i);
										}
									}}></textarea>
							</div>
						</div>
					</div>
					<div class="mt-2 flex items-center justify-end gap-2 pl-11">
						<button
							type="button"
							class="icon-btn"
							onclick={() => (steps = move(steps, i, i - 1))}
							disabled={i === 0}
							aria-label="Move step {i + 1} up">↑</button
						>
						<button
							type="button"
							class="icon-btn"
							onclick={() => (steps = move(steps, i, i + 1))}
							disabled={i === steps.length - 1}
							aria-label="Move step {i + 1} down">↓</button
						>
						<button
							type="button"
							class="icon-btn text-brick-dark"
							onclick={() => removeStep(i)}
							aria-label="Remove step {i + 1}">✕</button
						>
					</div>
				</li>
			{/each}
		</ol>
		<button type="button" class="btn-secondary btn-sm mt-2.5" onclick={() => addStep()}
			>+ Add step</button
		>
	</section>

	<section class="card p-4 sm:p-5">
		<div class="grid gap-4 sm:grid-cols-2">
			<div>
				<label class="label" for="source"
					>Source <span class="font-normal text-sage">(optional)</span></label
				>
				<input
					class="field"
					id="source"
					name="source"
					bind:value={source}
					placeholder="Grandma, cookbook page 12, a friend"
					maxlength="500"
				/>
			</div>
			<div class="sm:col-span-2">
				<label class="label" for="notes"
					>Notes <span class="font-normal text-sage">(optional)</span></label
				>
				<textarea class="field min-h-20" id="notes" name="notes" bind:value={notes} maxlength="8000"
				></textarea>
			</div>
		</div>
	</section>

	<div
		class="sticky bottom-[calc(72px+env(safe-area-inset-bottom))] z-20 -mx-4 flex flex-wrap items-center gap-2.5 border-t border-sand bg-cream/95 px-4 py-3 backdrop-blur md:bottom-0 md:mx-0 md:rounded-[16px] md:border"
	>
		<span class="text-[12px] text-sage">{dirty ? 'Unsaved changes' : 'No changes'}</span>
		<span class="flex-1"></span>
		<button class="btn-secondary" name="intent" value="draft" disabled={submitting}
			>Save draft</button
		>
		<button class="btn-primary" name="intent" value="save" disabled={submitting}
			>{submitting ? 'Saving…' : mode === 'new' ? 'Save recipe' : 'Save changes'}</button
		>
	</div>
</form>
