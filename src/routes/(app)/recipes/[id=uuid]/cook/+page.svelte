<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidate } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import IngredientAutocomplete from '$lib/components/IngredientAutocomplete.svelte';
	import { pushToast } from '$lib/client/toast.svelte';
	import { fmtNum, fmtQty } from '$lib/client/format';
	import { Dec } from '$lib/shared/decimal';
	import { scaleAmount } from '$lib/shared/scaling';
	import { displayQuantity } from '$lib/shared/display-units';
	import { ingredientLine } from '$lib/shared/ingredient-line';
	import { unitSystem } from '$lib/client/unit-system.svelte';
	import UnitToggle from '$lib/components/UnitToggle.svelte';
	import {
		COOK_MODES,
		COOK_TEXT_STEP_MAX,
		COOK_TEXT_STEP_MIN,
		cookTextSizes,
		cookView,
		setCookView
	} from '$lib/client/cook-view.svelte';

	let { data, form } = $props();
	type LooseForm =
		| {
				ok?: boolean;
				undone?: boolean;
				message?: string;
				eventId?: string;
				deductions?: number;
				plannedServingsFulfilled?: string | null;
				unplannedServings?: string | null;
				review?: {
					insufficient?: { lotId: string; requested: string; available: string; unit: string }[];
				};
		  }
		| null
		| undefined;
	const f = $derived(form as LooseForm);
	const r = $derived(data.recipe);
	const preview = $derived(data.preview);

	let checkedIng = $state<Record<number, boolean>>({});
	let doneSteps = $state<Record<string, boolean>>({});
	let finishOpen = $state(false);
	let settingsOpen = $state(false);
	let slideIndex = $state(0);
	const sizes = $derived(cookTextSizes(cookView.textStep));
	const slide = $derived(Math.min(slideIndex, Math.max(0, r.steps.length - 1)));
	const stepLabel = (i: number) =>
		`${r.steps[i].sectionTitle ? r.steps[i].sectionTitle + ' · ' : ''}Step ${i + 1}`;
	let servings = $derived(data.preview?.servings ?? data.recipe.baseServings ?? '1');

	interface Alloc {
		lotId: string;
		amount: string;
		revision: number;
		label: string;
	}
	interface ItemState {
		position: number;
		mode: 'deduct' | 'skip';
		ingredientId: string | null;
		ingredientName: string;
		substituteName: string;
		substituteId: string | null;
		substituteLabel: string | null;
		createIdentity: boolean;
		allocations: Alloc[];
		note: string;
		loading: boolean;
	}
	// items are edited in place inside the finish sheet, so they stay $state and resync when the preview changes
	// eslint-disable-next-line svelte/prefer-writable-derived
	let items = $state<ItemState[]>([]);
	$effect(() => {
		items = (data.preview?.items ?? []).map((it) => ({
			position: it.position,
			mode: it.defaultMode,
			ingredientId: it.ingredientId,
			ingredientName: it.ingredientName ?? it.name,
			substituteName: '',
			substituteId: null,
			substituteLabel: null,
			createIdentity: false,
			allocations: it.suggestions.map((s) => ({
				lotId: s.lotId,
				amount: Dec.from(s.take).toString(),
				revision: s.revision,
				label: `${fmtQty(s.quantity, s.unit)} · ${s.location || 'no location'}${s.expiresOn ? ' · use by ' + s.expiresOn : ''}`
			})),
			note: '',
			loading: false
		}));
	});

	async function loadSubstituteLots(i: number) {
		const item = items[i];
		const id = item.substituteId;
		if (!id) return;
		item.loading = true;
		try {
			const it = preview!.items[i];
			const res = await fetch(
				`/api/pantry-lots?ingredient=${encodeURIComponent(id)}&unit=${encodeURIComponent(it.unit ?? '')}&convention=${preview!.convention}`
			);
			if (!res.ok) throw new Error('Could not load lots');
			const json = (await res.json()) as {
				lots: {
					lotId: string;
					quantity: string;
					unit: string;
					location: string;
					expiresOn: string | null;
					revision: number;
					inRequestedUnit: string | null;
				}[];
			};
			if (items[i].substituteId !== id) return; // stale
			let remaining = it.scaledAmount ? Dec.from(it.scaledAmount) : null;
			items[i].allocations = json.lots.map((l) => {
				let take = '';
				if (remaining && l.inRequestedUnit && l.unit === it.unit) {
					const t = Dec.min(remaining, Dec.from(l.quantity));
					remaining = remaining.sub(t);
					take = t.toString();
				}
				return {
					lotId: l.lotId,
					amount: take,
					revision: l.revision,
					label: `${fmtQty(l.quantity, l.unit)} · ${l.location || 'no location'}${l.expiresOn ? ' · use by ' + l.expiresOn : ''}`
				};
			});
			items[i].ingredientId = id;
			items[i].mode = json.lots.length ? 'deduct' : 'skip';
		} catch (err) {
			pushToast((err as Error).message, { kind: 'error' });
		} finally {
			items[i].loading = false;
		}
	}

	const cookHref = (n: string) => `/recipes/${r.id}/cook?servings=${encodeURIComponent(n)}`;
	function bumpServings(delta: number) {
		const next = Dec.from(servings).add(Dec.from(delta));
		if (next.isPositive()) goto(cookHref(next.toString()), { noScroll: true, keepFocus: true });
	}
	const base = $derived(Dec.from(r.baseServings ?? '1'));
	const lines = $derived(
		r.ingredients.map((ing) => {
			const amt = ing.amount ? scaleAmount(Dec.from(ing.amount), base, Dec.from(servings)) : null;
			const qty = amt ? displayQuantity(amt, ing.unit, unitSystem.value, r.convention).text : null;
			const line = ingredientLine({
				quantity: qty ?? '',
				name: ing.name,
				preparation: ing.preparation
			});
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
		<div class="mb-4">
			<Alert kind="success">
				Pantry updated: {f.deductions}
				{f.deductions === 1 ? 'deduction' : 'deductions'}.
				{#if f.plannedServingsFulfilled && Dec.from(f.plannedServingsFulfilled).isPositive()}
					{fmtNum(f.plannedServingsFulfilled)} planned servings fulfilled.{/if}
				{#if f.unplannedServings && Dec.from(f.unplannedServings).isPositive()}
					{fmtNum(f.unplannedServings)} servings recorded as unplanned.{/if}
				<form
					method="post"
					action="?/undo"
					class="mt-2 inline"
					use:enhance={() =>
						async ({ result, update }) => {
							await update({ reset: false });
							if (result.type === 'success')
								pushToast('Cooking undone. Pantry restored.', { kind: 'success' });
							await invalidate('app:cook');
						}}
				>
					<input type="hidden" name="operationId" value={data.undoOperationId} />
					<input type="hidden" name="eventId" value={f.eventId} />
					<button class="btn-secondary btn-sm">Undo this cooking</button>
					<a href="/pantry/history" class="btn-ghost btn-sm">View history</a>
				</form>
			</Alert>
		</div>
	{:else if f?.undone}
		<div class="mb-4">
			<Alert kind="info">The cooking event was undone; its pantry deductions were reversed.</Alert>
		</div>
	{:else if f?.message}
		<div class="mb-4">
			<Alert kind="error"
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
		</div>
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
			<svg
				width="17"
				height="17"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
				><circle cx="12" cy="12" r="3"></circle><path
					d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
				></path></svg
			>
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
						{r.steps[slide].text}
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
							{step.text}
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

	<Sheet
		bind:open={finishOpen}
		title="Finish cooking {r.title}"
		description="Confirm servings and what actually left the pantry. Nothing is deducted until you confirm."
	>
		<form
			method="post"
			action="?/finish"
			class="flex flex-col gap-4"
			use:enhance={() =>
				async ({ result, update }) => {
					await update({ reset: false });
					if (result.type === 'success') {
						finishOpen = false;
						pushToast('Pantry updated.', { kind: 'success' });
						await invalidate('app:cook');
					}
				}}
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
			<ul class="flex flex-col gap-2.5">
				{#each preview.items as it, i (it.position)}
					{@const st = items[i]}
					{#if st}
						<li class="card p-3">
							<input type="hidden" name="item.{it.position}.name" value={it.name} />
							<input type="hidden" name="item.{it.position}.mode" value={st.mode} />
							<input
								type="hidden"
								name="item.{it.position}.ingredientId"
								value={st.ingredientId ?? ''}
							/>
							<div class="flex items-start justify-between gap-2">
								<div>
									<div class="text-[13.5px] font-semibold">
										{it.scaledAmount
											? fmtQty(it.scaledAmount, it.unit) + ' '
											: ''}{it.name}{it.optional ? ' (optional)' : ''}
									</div>
									{#if it.reason}<div class="mt-0.5 text-[11.5px] text-honey-dark">
											{it.reason}
										</div>{/if}
									{#if it.incompatible.length}<div class="mt-0.5 text-[11.5px] text-sage">
											Also in pantry: {it.incompatible
												.map((x) => fmtQty(x.quantity, x.unit))
												.join(', ')} (not convertible)
										</div>{/if}
								</div>
								<div
									class="flex flex-none rounded-[10px] bg-linen p-0.5 text-[11.5px] font-bold"
									role="group"
									aria-label="Tracking for {it.name}"
								>
									<button
										type="button"
										class="rounded-[8px] px-2.5 py-1.5 {st.mode === 'deduct'
											? 'bg-card text-leaf'
											: 'text-sage'}"
										aria-pressed={st.mode === 'deduct'}
										onclick={() => (st.mode = 'deduct')}
										disabled={!st.allocations.length}>Deduct</button
									>
									<button
										type="button"
										class="rounded-[8px] px-2.5 py-1.5 {st.mode === 'skip'
											? 'bg-card text-ink'
											: 'text-sage'}"
										aria-pressed={st.mode === 'skip'}
										onclick={() => (st.mode = 'skip')}>Skip tracking</button
									>
								</div>
							</div>
							{#if st.mode === 'deduct'}
								<div class="mt-2 flex flex-col gap-1.5">
									{#each st.allocations as a, ai (a.lotId)}
										<div class="flex items-center gap-2 text-[12.5px]">
											<input
												type="hidden"
												name="item.{it.position}.alloc.{ai}.lotId"
												value={a.lotId}
											/>
											<input
												type="hidden"
												name="item.{it.position}.alloc.{ai}.revision"
												value={a.revision}
											/>
											<label class="flex-1 text-sage" for="alloc-{it.position}-{ai}"
												>Lot: {a.label}</label
											>
											<input
												id="alloc-{it.position}-{ai}"
												class="field h-9 w-24 py-1 text-right"
												name="item.{it.position}.alloc.{ai}.amount"
												inputmode="decimal"
												bind:value={a.amount}
												aria-label="Amount to deduct from this lot"
											/>
											<span class="w-10 text-sage"
												>{preview.items[i].suggestions.find((s) => s.lotId === a.lotId)?.unit ??
													it.unit ??
													''}</span
											>
										</div>
									{/each}
								</div>
							{/if}
							<details class="mt-2 text-[12.5px]">
								<summary class="cursor-pointer text-leaf">Substitute or note</summary>
								<div class="mt-2 grid gap-2">
									<div>
										<label class="label" for="sub-{it.position}">Used a different ingredient</label>
										<IngredientAutocomplete
											inputId="sub-{it.position}"
											fieldName="item.{it.position}.subname"
											bind:name={st.substituteName}
											bind:ingredientId={st.substituteId}
											bind:identityLabel={st.substituteLabel}
											bind:createIdentity={st.createIdentity}
											placeholder="e.g. chicken thigh"
										/>
										{#if st.substituteId && st.substituteId !== st.ingredientId}
											<button
												type="button"
												class="btn-secondary btn-sm mt-1.5"
												onclick={() => loadSubstituteLots(i)}
												disabled={st.loading}
												>{st.loading ? 'Loading lots…' : 'Use its pantry lots'}</button
											>
										{/if}
									</div>
									<div>
										<label class="label" for="note-{it.position}">Note</label>
										<input
											id="note-{it.position}"
											class="field"
											name="item.{it.position}.note"
											bind:value={st.note}
											placeholder="e.g. used the last of the jar"
											maxlength="300"
										/>
									</div>
								</div>
							</details>
						</li>
					{/if}
				{/each}
			</ul>
			<button class="btn-primary h-12 w-full rounded-[16px]">Deduct from pantry</button>
			<p class="text-center text-[11.5px] text-sage-soft">
				Insufficient or changed stock produces a review, never a negative balance.
			</p>
		</form>
	</Sheet>
{/if}
