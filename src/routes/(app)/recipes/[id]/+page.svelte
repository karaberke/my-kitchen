<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import { pushToast } from '$lib/client/toast.svelte';
	import { fmtMinutes, fmtNum, fmtQty } from '$lib/client/format';
	import { Dec } from '$lib/shared/decimal';
	import { scaleAmount } from '$lib/shared/scaling';
	import { formatQuantity } from '$lib/shared/units';
	import { stockStatus, STOCK_STATUS_LABEL, type StockStatus } from '$lib/shared/stock-status';

	let { data, form } = $props();
	type LooseForm =
		| {
				ok?: boolean;
				message?: string;
				listId?: string;
				duplicate?: boolean;
				servings?: string;
				shared?: boolean;
		  }
		| null
		| undefined;
	const f = $derived(form as LooseForm);
	const r = $derived(data.recipe);

	let servings = $derived(Dec.from(data.recipe.baseServings ?? '1'));
	const base = $derived(Dec.from(r.baseServings ?? '1'));
	const scaled = $derived(
		!r.baseServings || servings.eq(base) ? null : servings.div(base).toHuman()
	);
	function bump(delta: number) {
		const next = servings.add(Dec.from(delta));
		if (next.isPositive() && next.lte(Dec.from(200))) servings = next;
	}

	interface Row {
		id: string;
		name: string;
		line: string;
		status: StockStatus;
		statusText: string;
		optional: boolean;
		preparation: string;
	}
	const groups = $derived.by(() => {
		const out: { name: string; rows: Row[] }[] = [];
		for (const ing of r.ingredients) {
			const amount = ing.amount ? scaleAmount(Dec.from(ing.amount), base, servings) : null;
			const available = ing.stockAvailable ? Dec.from(ing.stockAvailable) : null;
			const status = stockStatus({
				hasIdentity: !!ing.ingredientId,
				scaledAmount: amount,
				available,
				tracked: ing.stockTracked,
				otherStockCount: ing.stockOther.length
			});
			let statusText = STOCK_STATUS_LABEL[status];
			if (status === 'available' && available)
				statusText = `In pantry · ${formatQuantity(available, ing.unit)} available`;
			if (status === 'partial' && available && amount)
				statusText = `Short ${formatQuantity(amount.sub(available), ing.unit)} · ${formatQuantity(available, ing.unit)} in pantry`;
			if (status === 'unknown' && ing.stockOther.length)
				statusText = `Pantry has ${ing.stockOther.map((o) => fmtQty(o.quantity, o.unit)).join(', ')} · check while cooking`;
			if (!ing.amount && ing.ingredientId) statusText = 'Unspecified amount · check while cooking';
			const line = `${amount ? formatQuantity(amount, ing.unit) + ' ' : ''}${ing.name}${ing.preparation ? ', ' + ing.preparation : ''}`;
			const g =
				out.find((x) => x.name === ing.groupName) ??
				(out.push({ name: ing.groupName, rows: [] }), out[out.length - 1]);
			g.rows.push({
				id: ing.id,
				name: ing.name,
				line,
				status,
				statusText,
				optional: ing.optional,
				preparation: ing.preparation
			});
		}
		return out;
	});
	const availSummary = $derived.by(() => {
		let have = 0,
			need = 0;
		for (const g of groups)
			for (const row of g.rows)
				if (row.status !== 'unknown') {
					need++;
					if (row.status === 'available') have++;
				}
		return need ? `${have} of ${need} in pantry` : '';
	});
	const dot: Record<StockStatus, string> = {
		available: 'bg-leaf',
		partial: 'bg-honey',
		missing: 'bg-brick',
		untracked: 'bg-fog',
		unknown: 'bg-fog'
	};
	const statusColor: Record<StockStatus, string> = {
		available: 'text-leaf-dark',
		partial: 'text-honey-dark',
		missing: 'text-brick-dark',
		untracked: 'text-sage-soft',
		unknown: 'text-sage-soft'
	};

	let checked = $state<Record<string, boolean>>({});
	let shareOpen = $state(false);
	let planOpen = $state(false);
	let deleteOpen = $state(false);
	// svelte-ignore state_referenced_locally
	let planServings = $state(data.recipe.baseServings ?? '4');
	let fav = $derived(data.recipe.isFavorite);
	const optionalIngredients = $derived(r.ingredients.filter((i) => i.optional));
	const cookHref = $derived(
		`/recipes/${r.id}/cook?servings=${encodeURIComponent(servings.toString())}`
	);
</script>

<PageHeader
	title={r.title}
	subtitle={r.isOwner
		? r.shares.some((s) => s.shared)
			? `Yours · shared with ${r.shares
					.filter((s) => s.shared)
					.map((s) => s.name)
					.join(', ')}`
			: 'Yours · private'
		: `Shared by ${r.ownerName}`}
	back="/recipes"
>
	{#if r.isOwner}<a href="/recipes/{r.id}/edit" class="btn-secondary btn-sm">Edit</a>{/if}
</PageHeader>

{#if f?.message}
	<div class="mb-4"><Alert kind="error">{f.message}</Alert></div>
{/if}
{#if f?.ok && f?.listId}
	<div class="no-print mb-4">
		<Alert kind="success"
			>{f.duplicate
				? 'That plan was already on the list — nothing was duplicated.'
				: `Planned ${fmtNum(f.servings)} servings.`}
			<a class="font-bold underline" href="/grocery/{f.listId}">Open the grocery list</a></Alert
		>
	</div>
{/if}
{#if r.status === 'draft'}
	<div class="mb-4">
		<Alert kind="warn"
			>This is a draft. Add servings, ingredients and steps to use it for grocery planning and
			cooking.</Alert
		>
	</div>
{:else if r.status === 'archived'}
	<div class="mb-4">
		<Alert kind="info">This recipe is archived. It stays available here and in history.</Alert>
	</div>
{/if}

<article class="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
	<div>
		<div
			class="overflow-hidden rounded-[18px] bg-[linear-gradient(155deg,#cfe1ea_0%,#dee9d7_46%,#c6d8b8_100%)]"
			style="aspect-ratio: 3 / 2"
		>
			{#if r.image}
				<img
					src="/media/{r.image.id}/detail?v={r.image.version}"
					alt={r.title}
					width={r.image.variants.detail?.width}
					height={r.image.variants.detail?.height}
					class="h-full w-full object-cover"
					decoding="async"
				/>
			{:else}
				<div class="flex h-full items-center justify-center font-mono text-[10.5px] text-sage-soft">
					no photo
				</div>
			{/if}
		</div>
		{#if r.description}<p class="mt-3.5 text-[14px] leading-relaxed text-ink-soft">
				{r.description}
			</p>{/if}
		<div class="mt-3 flex flex-wrap gap-2 text-[12px] text-moss-soft">
			{#if r.prepMinutes}<span class="rounded-lg bg-linen px-2.5 py-1.5"
					>Prep {fmtMinutes(r.prepMinutes)}</span
				>{/if}
			{#if r.cookMinutes}<span class="rounded-lg bg-linen px-2.5 py-1.5"
					>Cook {fmtMinutes(r.cookMinutes)}</span
				>{/if}
			{#if r.baseServings}<span class="rounded-lg bg-linen px-2.5 py-1.5"
					>{fmtNum(r.baseServings)} servings{r.yieldNote ? ` · ${r.yieldNote}` : ''}</span
				>{:else if r.yieldNote}<span class="rounded-lg bg-linen px-2.5 py-1.5">{r.yieldNote}</span
				>{/if}
			{#each r.tags as tag (tag)}<a
					href="/recipes?tag={encodeURIComponent(tag)}"
					class="rounded-lg bg-parchment px-2.5 py-1.5 text-sage">#{tag}</a
				>{/each}
		</div>

		<div class="no-print mt-4 flex flex-wrap gap-2">
			<form
				method="post"
				action="?/favorite"
				use:enhance={() => {
					fav = !fav;
					return async ({ result, update }) => {
						if (result.type !== 'success') fav = !fav;
						await update({ reset: false, invalidateAll: false });
					};
				}}
			>
				<input type="hidden" name="favorite" value={fav ? '0' : '1'} />
				<button class="btn-secondary btn-sm" aria-pressed={fav}
					>{fav ? '★ Favorited' : '☆ Favorite'}</button
				>
			</form>
			{#if r.isOwner && r.shares.length}
				<button class="btn-secondary btn-sm" onclick={() => (shareOpen = true)}>Share…</button>
			{/if}
			<form method="post" action="?/duplicate" use:enhance>
				<button class="btn-secondary btn-sm">Duplicate</button>
			</form>
			<a
				href="/recipes/{r.id}/export.json"
				class="btn-secondary btn-sm"
				download="{r.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json">Export JSON</a
			>
			<a
				href="/recipes/{r.id}/print.txt"
				class="btn-secondary btn-sm"
				target="_blank"
				rel="noopener">Plain text</a
			>
			<button class="btn-secondary btn-sm" onclick={() => window.print()}>Print</button>
			{#if r.isOwner}
				<form method="post" action="?/archive" use:enhance>
					<input type="hidden" name="archived" value={r.status === 'archived' ? '0' : '1'} />
					<button class="btn-ghost btn-sm"
						>{r.status === 'archived' ? 'Unarchive' : 'Archive'}</button
					>
				</form>
				<button class="btn-ghost btn-sm text-brick-dark" onclick={() => (deleteOpen = true)}
					>Delete</button
				>
			{/if}
		</div>
		{#if r.sourceAttribution}<p class="mt-3 text-[12px] text-sage">{r.sourceAttribution}</p>{/if}

		<div class="card mt-5 flex items-center justify-between gap-3 p-3.5">
			<div>
				<div class="text-[13px] font-bold">Servings</div>
				<div class="mt-0.5 text-[11.5px] text-sage">
					{scaled
						? `Scaled ×${scaled} from ${fmtNum(r.baseServings)} · base quantities unchanged`
						: `Original yield${r.yieldNote ? ' · ' + r.yieldNote : ''}`}
				</div>
			</div>
			<div
				class="no-print flex items-center gap-1 rounded-[14px] bg-linen p-1"
				role="group"
				aria-label="Servings"
			>
				<button
					class="h-9 w-9 rounded-[11px] bg-cream text-[17px] font-semibold hover:bg-card"
					onclick={() => bump(-1)}
					aria-label="Fewer servings"
					disabled={!r.baseServings}>−</button
				>
				<output class="w-10 text-center text-[15px] font-bold" aria-live="polite"
					>{servings.toHuman()}</output
				>
				<button
					class="h-9 w-9 rounded-[11px] bg-cream text-[17px] font-semibold hover:bg-card"
					onclick={() => bump(1)}
					aria-label="More servings"
					disabled={!r.baseServings}>+</button
				>
			</div>
		</div>

		<div class="mt-5 mb-2.5 flex items-center justify-between">
			<h2 class="text-[17px]">Ingredients</h2>
			{#if availSummary}<span class="text-[11.5px] text-sage">{availSummary}</span>{/if}
		</div>
		{#if r.ingredients.length === 0}
			<p class="text-[13px] text-sage">No ingredients yet.</p>
		{/if}
		{#each groups as g (g.name)}
			<section class="mb-3.5">
				{#if g.name}<h3 class="eyebrow px-0.5 pb-2 font-sans">{g.name}</h3>{/if}
				<ul class="card overflow-hidden">
					{#each g.rows as row (row.id)}
						<li class="divider-row flex items-start gap-2.5 px-3.5 py-2.5">
							<span
								class="mt-[7px] h-2 w-2 flex-none rounded-full {dot[row.status]}"
								title={STOCK_STATUS_LABEL[row.status]}
							></span>
							<div class="min-w-0 flex-1">
								<div class="text-[14px] leading-snug">
									{row.line}{#if row.optional}<span class="ml-1.5 text-[11px] text-sage-soft"
											>(optional)</span
										>{/if}
								</div>
								<div class="mt-0.5 text-[11.5px] {statusColor[row.status]}">{row.statusText}</div>
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/each}

		<div class="no-print mt-3 mb-5 flex gap-2.5">
			<button
				class="btn-secondary flex-1 rounded-[16px]"
				disabled={!r.cookable || !data.household}
				onclick={() => (planOpen = true)}>Add to grocery list</button
			>
			<a
				href={cookHref}
				class="btn-primary flex-1 rounded-[16px] {!r.cookable || !data.household
					? 'pointer-events-none opacity-50'
					: ''}"
				aria-disabled={!r.cookable || !data.household}>Cook this</a
			>
		</div>
	</div>

	<div>
		<h2 class="mb-2.5 text-[17px]">Instructions</h2>
		{#if r.steps.length === 0}
			<p class="text-[13px] text-sage">No steps yet.</p>
		{/if}
		<ol class="flex flex-col gap-2.5">
			{#each r.steps as step, i (step.id)}
				{#if step.sectionTitle && (i === 0 || r.steps[i - 1].sectionTitle !== step.sectionTitle)}
					<li class="eyebrow list-none px-0.5 pt-2 font-sans">{step.sectionTitle}</li>
				{/if}
				<li class="flex gap-3">
					<button
						class="no-print mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11.5px] font-bold transition-colors {checked[
							step.id
						]
							? 'bg-leaf text-cream'
							: 'bg-leaf-soft text-moss'}"
						aria-pressed={!!checked[step.id]}
						aria-label="Mark step {i + 1} done"
						onclick={() => (checked[step.id] = !checked[step.id])}
						>{checked[step.id] ? '✓' : i + 1}</button
					>
					<span class="hidden print:inline">{i + 1}.</span>
					<p
						class="flex-1 text-[14px] leading-relaxed {checked[step.id]
							? 'text-sage line-through'
							: 'text-[#354031]'}"
					>
						{step.text}
					</p>
				</li>
			{/each}
		</ol>
		<p class="no-print mt-3 text-[11.5px] text-sage-soft">
			Checking steps is just for you while cooking. Only “Finish cooking” updates the pantry.
		</p>
		<a
			href={cookHref}
			class="btn-secondary no-print mt-4 w-full rounded-[16px] {!r.cookable || !data.household
				? 'pointer-events-none opacity-50'
				: ''}">Open cooking view</a
		>

		{#if r.notes || r.source || r.sourceFile}
			<div class="card-muted mt-5 p-3.5">
				<div class="eyebrow">Notes &amp; source</div>
				{#if r.notes}<p class="mt-2 text-[13px] leading-relaxed whitespace-pre-line text-ink-soft">
						{r.notes}
					</p>{/if}
				{#if r.source}<p class="mt-2 text-[12px] text-sage">Source: {r.source}</p>{/if}
				{#if r.sourceFile}
					<p class="mt-2 text-[12px] text-sage">
						Imported from <a
							href="/media/attachment/{r.sourceFile.id}"
							target="_blank"
							rel="noopener">{r.sourceFile.filename}</a
						>{r.sourceFile.pageCount ? ` · ${r.sourceFile.pageCount} pages` : ''}
					</p>
				{/if}
			</div>
		{/if}
	</div>
</article>

<Sheet
	bind:open={shareOpen}
	title="Share this recipe"
	description="Members of a household can view it. Only you can edit it. Unsharing removes their access immediately."
>
	<ul class="card overflow-hidden">
		{#each r.shares as s (s.householdId)}
			<li class="divider-row flex items-center gap-3 px-3.5 py-3">
				<div class="flex-1 text-[13.5px] font-semibold">{s.name}</div>
				<form
					method="post"
					action="?/share"
					use:enhance={() =>
						async ({ update }) => {
							await update({ reset: false });
							await invalidate('app:recipe');
						}}
				>
					<input type="hidden" name="householdId" value={s.householdId} />
					<input type="hidden" name="shared" value={s.shared ? '0' : '1'} />
					<button class="{s.shared ? 'btn-secondary' : 'btn-primary'} btn-sm"
						>{s.shared ? 'Unshare' : 'Share'}</button
					>
				</form>
			</li>
		{/each}
	</ul>
</Sheet>

<Sheet
	bind:open={planOpen}
	title="Add to grocery list"
	description={data.currentList && data.currentList.status === 'draft'
		? `Adds a batch to “${data.currentList.name}”. Matching ingredients are combined and pantry stock is subtracted once when the list is recalculated.`
		: 'Creates a new draft list for this household.'}
>
	<form
		method="post"
		action="?/addToList"
		class="flex flex-col gap-4"
		use:enhance={() =>
			async ({ result, update }) => {
				await update({ reset: false });
				if (result.type === 'success') {
					planOpen = false;
					pushToast('Recipe planned. Review the grocery draft before shopping.', {
						kind: 'success',
						action: {
							label: 'Open list',
							href: `/grocery/${(result.data as { listId?: string })?.listId ?? ''}`
						}
					});
				}
			}}
	>
		<input type="hidden" name="clientKey" value={data.clientKey} />
		{#if data.currentList?.status === 'draft'}<input
				type="hidden"
				name="listId"
				value={data.currentList.id}
			/>{/if}
		<div>
			<label class="label" for="plan-servings">Servings to plan</label>
			<input
				class="field"
				id="plan-servings"
				name="servings"
				inputmode="decimal"
				bind:value={planServings}
				required
			/>
		</div>
		{#if optionalIngredients.length}
			<fieldset>
				<legend class="label">Optional ingredients to include</legend>
				<div class="flex flex-col gap-2">
					{#each optionalIngredients as ing (ing.id)}
						<label class="flex min-h-10 items-center gap-2.5 text-[13.5px]"
							><input
								type="checkbox"
								name="includeOptional"
								value={ing.position}
								class="h-5 w-5 accent-leaf"
							/>
							{ing.name}</label
						>
					{/each}
				</div>
			</fieldset>
		{/if}
		<button class="btn-primary w-full">Add to list</button>
	</form>
</Sheet>

<Sheet
	bind:open={deleteOpen}
	title="Delete this recipe?"
	description="Cooking and purchase history keeps the recipe title and quantities. Shared members lose access right away. This cannot be undone."
>
	<form method="post" action="?/delete" class="flex gap-2.5" use:enhance>
		<button type="button" class="btn-secondary flex-1" onclick={() => (deleteOpen = false)}
			>Cancel</button
		>
		<button class="btn-danger flex-1">Delete recipe</button>
	</form>
</Sheet>
