<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidate } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import CookItems from '$lib/components/CookItems.svelte';
	import RecipeChat from '$lib/components/RecipeChat.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { onSuccess } from '$lib/client/enhance';
	import { fmtNum, fmtQty, scaledIngredientLine } from '$lib/client/format';
	import { Dec } from '$lib/shared/decimal';
	import { unitSystem } from '$lib/client/unit-system.svelte';
	import StepText from '$lib/components/StepText.svelte';
	import UnitToggle from '$lib/components/UnitToggle.svelte';
	import {
		COOK_MODES,
		COOK_TEXT_STEP_MAX,
		COOK_TEXT_STEP_MIN,
		cookTextSizes,
		cookView,
		setCookView
	} from '$lib/client/cook-view.svelte';
	import { prepareStepIngredients } from '$lib/shared/step-amounts';

	let { data, form } = $props();
	const f = $derived(form);
	const r = $derived(data.recipe);
	const preview = $derived(data.preview);

	let checkedIng = $state<Record<number, boolean>>({});
	let doneSteps = $state<Record<string, boolean>>({});
	let finishOpen = $state(false);
	let settingsOpen = $state(false);
	let slideIndex = $state(0);
	let chatOpen = $state(false);
	const sizes = $derived(cookTextSizes(cookView.textStep));
	const slide = $derived(Math.min(slideIndex, Math.max(0, r.steps.length - 1)));
	const stepLabel = (i: number) =>
		`${r.steps[i].sectionTitle ? r.steps[i].sectionTitle + ' · ' : ''}Step ${i + 1}`;
	let servings = $derived(data.preview?.servings ?? data.recipe.baseServings ?? '1');
	/** The 1-based step the cook is on: the slide shown, or the first step not ticked off. Undefined when none. */
	const chatStep = $derived.by(() => {
		if (!r.steps.length) return undefined;
		if (cookView.mode === 'slides') return slide + 1;
		const i = r.steps.findIndex((s) => !doneSteps[s.id]);
		return i < 0 ? undefined : i + 1;
	});

	const cookHref = (n: string) => `/recipes/${r.id}/cook?servings=${encodeURIComponent(n)}`;
	function bumpServings(delta: number) {
		const next = Dec.from(servings).add(Dec.from(delta));
		if (next.isPositive()) goto(cookHref(next.toString()), { noScroll: true, keepFocus: true });
	}
	const base = $derived(Dec.from(r.baseServings ?? '1'));
	// Parsed once per recipe; every step shares it.
	const stepIngredients = $derived(prepareStepIngredients(r.ingredients));
	const lines = $derived(
		r.ingredients.map((ing) => {
			const { line } = scaledIngredientLine(
				ing,
				base,
				Dec.from(servings),
				unitSystem.value,
				r.convention
			);
			return `${line}${ing.optional ? ' (optional)' : ''}`;
		})
	);
</script>

<PageHeader
	title="Cooking"
	subtitle="{r.title} · {fmtNum(servings)} servings"
	back="/recipes/{r.id}"
>
	<div
		class="flex items-center gap-1 rounded-[14px] bg-linen p-1"
		role="group"
		aria-label="Servings"
	>
		<button
			class="h-8 w-8 rounded-[10px] bg-cream text-[16px] font-semibold"
			onclick={() => bumpServings(-1)}
			aria-label="Fewer servings">−</button
		>
		<span class="w-8 text-center text-[14px] font-bold">{fmtNum(servings)}</span>
		<button
			class="h-8 w-8 rounded-[10px] bg-cream text-[16px] font-semibold"
			onclick={() => bumpServings(1)}
			aria-label="More servings">+</button
		>
	</div>
</PageHeader>

{#if !preview}
	<Alert kind="warn"
		>This recipe is not complete enough to cook from. Add base servings, ingredients and steps
		first.</Alert
	>
{:else}
	{#if f?.ok}
		<Alert class="mb-4" kind="success">
			Pantry updated: {f.deductions}
			{f.deductions === 1 ? 'deduction' : 'deductions'}.
			{#if f.plannedServingsFulfilled && Dec.from(f.plannedServingsFulfilled).isPositive()}
				{fmtNum(f.plannedServingsFulfilled)} planned servings fulfilled.{/if}
			{#if f.unplannedServings && Dec.from(f.unplannedServings).isPositive()}
				{fmtNum(f.unplannedServings)} servings recorded as unplanned.{/if}
			<!-- A failed undo changes nothing on the page, so reload the preview. -->
			<form
				method="post"
				action="?/undo"
				class="mt-2 inline"
				use:enhance={onSuccess('Cooking undone. Pantry restored.', {
					invalidateOnFailure: 'app:cook'
				})}
			>
				<input type="hidden" name="operationId" value={data.undoOperationId} />
				<input type="hidden" name="eventId" value={f.eventId} />
				<button class="btn-secondary btn-sm">Undo this cooking</button>
				<a href="/pantry/history" class="btn-ghost btn-sm">View history</a>
			</form>
		</Alert>
	{:else if f?.undone}
		<Alert class="mb-4" kind="info"
			>The cooking event was undone; its pantry deductions were reversed.</Alert
		>
	{:else if f?.message}
		<Alert class="mb-4" kind="error"
			>{f.message}{#if f.review?.insufficient?.length}
				— {#each f.review.insufficient as s (s.lotId)}<span
						>{fmtQty(s.available, s.unit)} available where {fmtQty(s.requested, s.unit)} was requested.
					</span>{/each}{/if}
			<button
				class="font-bold underline"
				onclick={() => invalidate('app:cook').then(() => (finishOpen = true))}
				>Refresh the preview</button
			></Alert
		>
	{/if}

	<div class="mb-3.5 flex items-center justify-end gap-3.5">
		<div class="flex items-center gap-3.5" role="group" aria-label="Cooking view">
			{#each COOK_MODES as m (m.value)}
				<button
					type="button"
					class="border-b-[1.5px] py-1 text-[12.5px] font-semibold transition-colors {cookView.mode ===
					m.value
						? 'border-ink text-ink'
						: 'border-transparent text-sage-soft hover:text-ink'}"
					aria-pressed={cookView.mode === m.value}
					onclick={() => setCookView({ mode: m.value })}>{m.label}</button
				>
			{/each}
		</div>
		<button
			type="button"
			class="flex h-8 w-8 items-center justify-center rounded-[10px] text-moss-soft transition-colors hover:bg-linen {settingsOpen
				? 'bg-linen'
				: ''}"
			aria-label="Cooking view settings"
			aria-expanded={settingsOpen}
			aria-controls="cook-settings"
			onclick={() => (settingsOpen = !settingsOpen)}
		>
			<Icon name="gear" size={17} />
		</button>
	</div>
	{#if settingsOpen}
		<div
			id="cook-settings"
			class="mb-3.5 flex items-center justify-between gap-3 rounded-[14px] border border-sand bg-parchment py-2.5 pr-3 pl-3.5"
		>
			<div class="text-[13px] font-semibold">Text size</div>
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="h-9 w-10 rounded-[10px] border border-sand-dark bg-card text-[13px] font-bold disabled:text-fog"
					aria-label="Smaller text"
					disabled={cookView.textStep <= COOK_TEXT_STEP_MIN}
					onclick={() => setCookView({ textStep: cookView.textStep - 1 })}>A−</button
				>
				<div class="min-w-11 text-center text-[12.5px] text-moss-soft" aria-live="polite">
					{sizes.percent}
				</div>
				<button
					type="button"
					class="h-9 w-10 rounded-[10px] border border-sand-dark bg-card text-[16px] font-bold disabled:text-fog"
					aria-label="Larger text"
					disabled={cookView.textStep >= COOK_TEXT_STEP_MAX}
					onclick={() => setCookView({ textStep: cookView.textStep + 1 })}>A+</button
				>
			</div>
		</div>
	{/if}

	<div class="grid gap-5 lg:grid-cols-[1fr_1.3fr]">
		<section class="card p-3.5" aria-labelledby="cook-ing">
			<div class="mb-2 flex items-center justify-between gap-2">
				<h2 id="cook-ing" class="eyebrow font-sans">Ingredients · tap to check off</h2>
				<UnitToggle />
			</div>
			<ul>
				{#each r.ingredients as ing, i (ing.id)}
					<li class="divider-row">
						<button
							class="flex w-full items-center gap-3 py-2.5 text-left"
							aria-pressed={!!checkedIng[i]}
							onclick={() => (checkedIng[i] = !checkedIng[i])}
						>
							<span
								class="flex h-6 w-6 flex-none items-center justify-center rounded-[7px] border-[1.5px] text-[12px] text-cream {checkedIng[
									i
								]
									? 'border-leaf bg-leaf'
									: 'border-[#c6c2a6] bg-card'}">{checkedIng[i] ? '✓' : ''}</span
							>
							<span
								class="flex-1 leading-snug {checkedIng[i] ? 'text-sage line-through' : ''}"
								style:font-size={sizes.ingredient}>{lines[i]}</span
							>
						</button>
					</li>
				{/each}
			</ul>
			<p class="mt-2 text-[11.5px] text-sage-soft">
				Checking items here changes nothing in the pantry.
			</p>
		</section>
		{#if cookView.mode === 'slides' && r.steps.length}
			<section class="flex flex-col" aria-label="Steps">
				<div
					class="card mb-3.5 flex min-h-[280px] flex-col gap-3.5 rounded-[20px] px-5 py-[22px]"
					aria-live="polite"
				>
					<div class="eyebrow flex items-baseline justify-between gap-2.5 font-sans">
						<span>{stepLabel(slide)}</span>
						<span class="tracking-normal">{slide + 1} / {r.steps.length}</span>
					</div>
					<p class="font-serif leading-relaxed text-pretty" style:font-size={sizes.slide}>
						<StepText
							text={r.steps[slide].text}
							ingredients={stepIngredients}
							{base}
							servings={Dec.from(servings)}
							convention={r.convention}
						/>
					</p>
				</div>
				<div class="mb-2.5 flex items-center justify-between gap-2.5">
					<button
						type="button"
						class="h-12 w-12 rounded-full border border-sand-dark text-[18px] disabled:text-fog"
						aria-label="Previous step"
						disabled={slide === 0}
						onclick={() => (slideIndex = slide - 1)}>←</button
					>
					<div class="flex flex-wrap justify-center gap-1.5">
						{#each r.steps as step, i (step.id)}
							<button
								type="button"
								class="h-1.5 w-1.5 rounded-full {i === slide ? 'bg-ink' : 'bg-sand-dark'}"
								aria-label="Go to step {i + 1}"
								aria-current={i === slide ? 'step' : undefined}
								onclick={() => (slideIndex = i)}
							></button>
						{/each}
					</div>
					{#if slide < r.steps.length - 1}
						<button
							type="button"
							class="h-12 w-12 rounded-full bg-leaf text-[18px] text-cream transition-colors hover:bg-leaf-dark"
							aria-label="Next step"
							onclick={() => (slideIndex = slide + 1)}>→</button
						>
					{:else}
						<button
							type="button"
							class="btn-primary h-12 rounded-full px-[18px]"
							onclick={() => (finishOpen = true)}
							disabled={!!f?.ok}>Finish</button
						>
					{/if}
				</div>
			</section>
		{:else}
			<section class="flex flex-col gap-3" aria-label="Steps">
				{#each r.steps as step, i (step.id)}
					<button
						class="card w-full p-4 text-left transition-colors {doneSteps[step.id]
							? 'bg-parchment'
							: ''}"
						aria-pressed={!!doneSteps[step.id]}
						onclick={() => (doneSteps[step.id] = !doneSteps[step.id])}
					>
						<div class="eyebrow mb-2 font-sans">
							{stepLabel(i)}{doneSteps[step.id] ? ' · done' : ''}
						</div>
						<p
							class="leading-relaxed {doneSteps[step.id] ? 'text-sage' : 'text-ink'}"
							style:font-size={sizes.step}
						>
							<StepText
								text={step.text}
								ingredients={stepIngredients}
								{base}
								servings={Dec.from(servings)}
								convention={r.convention}
							/>
						</p>
					</button>
				{/each}
				<button
					class="btn-primary h-12 w-full rounded-[16px] text-[14px]"
					onclick={() => (finishOpen = true)}
					disabled={!!f?.ok}>Finish &amp; update pantry</button
				>
			</section>
		{/if}
	</div>

	{#if data.aiEnabled}
		<!-- Phones: above the tab bar (64px) and the toasts' row; the spacer keeps the last content clear of it. -->
		<div class="h-16" aria-hidden="true"></div>
		<button
			type="button"
			class="btn-primary no-print fixed right-4 bottom-[calc(80px+env(safe-area-inset-bottom))] z-30 h-12 rounded-full px-5 shadow-sheet md:right-8 md:bottom-6"
			aria-haspopup="dialog"
			onclick={() => (chatOpen = true)}
		>
			<Icon name="chat" size={18} />
			Ask
		</button>
		<Sheet
			bind:open={chatOpen}
			title="Ask the assistant"
			description="Questions about {r.title}. The assistant sees the recipe at {fmtNum(
				servings
			)} servings."
		>
			<RecipeChat
				recipeId={r.id}
				step={chatStep}
				servings={String(servings)}
				storageKey="recipe-chat:{r.id}"
				voice
			/>
		</Sheet>
	{/if}

	<Sheet
		bind:open={finishOpen}
		title="Finish cooking {r.title}"
		description="Confirm servings and what actually left the pantry. Nothing is deducted until you confirm."
	>
		<form
			method="post"
			action="?/finish"
			class="flex flex-col gap-4"
			use:enhance={onSuccess('Pantry updated.', { then: () => (finishOpen = false) })}
		>
			<input type="hidden" name="operationId" value={data.operationId} />
			<input type="hidden" name="expectedRecipeRevision" value={preview.revision} />
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="label" for="finish-servings">Servings prepared</label>
					<input
						class="field"
						id="finish-servings"
						name="servings"
						inputmode="decimal"
						bind:value={servings}
					/>
				</div>
				<div>
					<label class="label" for="finish-batch">Planned batch</label>
					<select class="field" id="finish-batch" name="batchId">
						<option value="">Not from a plan</option>
						{#each preview.batches as b (b.id)}
							<option value={b.id}
								>{b.listName} · {fmtNum(b.remainingServings)} of {fmtNum(b.servings)} servings left</option
							>
						{/each}
					</select>
				</div>
			</div>
			{#key preview}
				<CookItems {preview} />
			{/key}
			<button class="btn-primary h-12 w-full rounded-[16px]">Deduct from pantry</button>
			<p class="text-center text-[11.5px] text-sage-soft">
				Insufficient or changed stock produces a review, never a negative balance.
			</p>
		</form>
	</Sheet>
{/if}
