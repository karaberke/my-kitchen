<script lang="ts">
	import { enhance } from '$app/forms';
	import { beforeNavigate } from '$app/navigation';
	import Alert from './Alert.svelte';
	import RecipeImagePicker from './RecipeImagePicker.svelte';
	import RecipeIngredientRows, {
		blankIngredient,
		rowFrom,
		type IngredientRow
	} from './RecipeIngredientRows.svelte';
	import { focusRow, move } from '$lib/client/rows';
	import { resizeForUpload } from '$lib/client/image-resize';
	import {
		parseRecipeForm,
		validateRecipe,
		type FieldErrors,
		type RecipeFormInput
	} from '$lib/shared/recipe-input';

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
		action = '',
		assistant = false,
		proposed = false
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
		/** Offer "Tidy with assistant" (edit page only; needs an `aiFix` action). */
		assistant?: boolean;
		/** `initial` is an unsaved proposal (an assistant tidy), so it counts as a change. */
		proposed?: boolean;
	} = $props();

	const AI_FIX_ACTION = '?/aiFix';

	let seq = 0;
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
		initial.ingredients.length
			? initial.ingredients.map((i) => rowFrom(i, identityLabels))
			: [blankIngredient()]
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
	/* svelte-ignore state_referenced_locally */
	let imageUrl = $state(initial.imageUrl);
	let submitting = $state(false);
	let tidying = $state(false);

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
			removeImage,
			imageUrl
		});
	const initialSnapshot = snapshot();
	/** The full comparison. Costly, so it runs on commit and on leaving, not per keystroke. */
	const differs = () => proposed || snapshot() !== initialSnapshot;
	/** What the status line shows; a keystroke only raises it, a commit settles it. */
	let edited = $state(false);
	const dirty = $derived(proposed || edited);
	/** Per keystroke: something may differ now. */
	const onInput = () => (edited = true);
	/** On commit (a field is left, a row is added or moved): compare for real. */
	const settle = () => (edited = differs());

	beforeNavigate((nav) => {
		if (
			differs() &&
			!submitting &&
			!nav.willUnload &&
			!confirm('You have unsaved changes. Leave without saving?')
		)
			nav.cancel();
	});
	function onBeforeUnload(e: BeforeUnloadEvent) {
		if (differs() && !submitting) e.preventDefault();
	}
	function addStep(after?: number) {
		const idx = after === undefined ? steps.length : after + 1;
		steps = [
			...steps.slice(0, idx),
			blankStep(steps[after ?? steps.length - 1]?.section ?? ''),
			...steps.slice(idx)
		];
		focusRow('step', idx, 'text');
		settle();
	}
	function removeStep(i: number) {
		steps = steps.filter((_, idx) => idx !== i);
		if (!steps.length) steps = [blankStep()];
		settle();
	}
	function moveStep(from: number, to: number) {
		steps = move(steps, from, to);
		settle();
	}

	// Drag & drop (pointer) — keyboard users have the up/down buttons.
	let dragging = $state<number | null>(null);
	function onDrop(index: number) {
		if (dragging === null) return;
		moveStep(dragging, index);
		dragging = null;
	}
</script>

<svelte:window onbeforeunload={onBeforeUnload} />

<form
	method="post"
	{action}
	enctype="multipart/form-data"
	class="flex flex-col gap-6"
	oninput={onInput}
	onchange={settle}
	onfocusout={settle}
	use:enhance={async ({ formData, action: target, cancel }) => {
		// The tidy proposal is allowed to fix what validation would refuse, and it
		// saves nothing, so it skips the checks and the photo resize below.
		if (target.search === AI_FIX_ACTION) {
			clientErrors = {};
			clientMessage = '';
			submitting = true;
			tidying = true;
			return async ({ update }) => {
				submitting = false;
				tidying = false;
				await update({ reset: false });
			};
		}
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
			<RecipeImagePicker {image} bind:removeImage bind:imageUrl error={errors.image} />
		</div>
	</section>

	<RecipeIngredientRows bind:rows={ingredients} {errors} onsettle={settle} />

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
							onclick={() => moveStep(i, i - 1)}
							disabled={i === 0}
							aria-label="Move step {i + 1} up">↑</button
						>
						<button
							type="button"
							class="icon-btn"
							onclick={() => moveStep(i, i + 1)}
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
		<span class="text-[12px] text-sage" aria-live="polite"
			>{tidying
				? 'Reading the recipe with the assistant… this can take a minute.'
				: dirty
					? 'Unsaved changes'
					: 'No changes'}</span
		>
		<span class="flex-1"></span>
		<button class="btn-secondary" name="intent" value="draft" disabled={submitting}
			>Save draft</button
		>
		<button class="btn-primary" name="intent" value="save" disabled={submitting}
			>{submitting && !tidying
				? 'Saving…'
				: mode === 'new'
					? 'Save recipe'
					: 'Save changes'}</button
		>
		<!-- After the save buttons in DOM order, so Enter in a field never starts it. -->
		{#if assistant}
			<button
				class="btn-secondary"
				formaction={AI_FIX_ACTION}
				formnovalidate
				disabled={submitting}
				aria-busy={tidying}>{tidying ? 'Tidying…' : 'Tidy with assistant'}</button
			>
		{/if}
	</div>
</form>
