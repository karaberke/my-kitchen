<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import PollRevisions from '$lib/components/PollRevisions.svelte';
	import { fmtMinutes } from '$lib/client/format';

	let { data, form } = $props();

	let addOpen = $state(false);
	let addDay = $state('');
	let noteText = $state('');

	function openAdd(date: string) {
		addDay = date;
		noteText = '';
		addOpen = true;
	}

	const dayName = (iso: string) =>
		new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' });
	const dayDate = (iso: string) =>
		new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

	/** "40 min prep · 1 h cook · 4 servings" — blank parts are dropped. */
	function recipeSub(e: {
		prepMinutes: number | null;
		cookMinutes: number | null;
		baseServings: string | null;
	}) {
		const parts = [];
		if (e.prepMinutes) parts.push(`${fmtMinutes(e.prepMinutes)} prep`);
		if (e.cookMinutes) parts.push(`${fmtMinutes(e.cookMinutes)} cook`);
		if (e.baseServings) parts.push(`${Number(e.baseServings)} servings`);
		return parts.join(' · ');
	}

	const planned = $derived(data.days.reduce((n, d) => n + d.entries.length, 0));
	const daysUsed = $derived(data.days.filter((d) => d.entries.length).length);
	const anyRecipe = $derived(data.days.some((d) => d.entries.some((e) => e.recipeId)));

	const after =
		() =>
		async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			await invalidateAll();
		};
</script>

<PageHeader title="This week" subtitle={data.household?.name ?? ''}>
	{#if data.household}<PollRevisions
			householdId={data.household.id}
			watch={['plan']}
			initial={data.revisions}
			intervalMs={data.pollMs}
			dependsOn="app:plan"
		/>{/if}
</PageHeader>

{#if form?.message}<div class="mb-3"><Alert kind="error">{form.message}</Alert></div>{/if}

<form
	method="post"
	action="?/toGrocery"
	use:enhance={() =>
		async ({ update }) => {
			await update({ reset: false });
		}}
>
	<input type="hidden" name="start" value={data.start} />
	<button
		class="h-[42px] w-full rounded-[14px] border border-sand-dark bg-card text-[12.5px] font-bold hover:bg-parchment disabled:cursor-not-allowed disabled:opacity-50"
		disabled={!anyRecipe}
		title={anyRecipe ? undefined : 'Plan a recipe first'}
	>
		Add this week to grocery list
	</button>
</form>
<div class="px-0.5 pt-2.5 pb-3 text-[11.5px] text-sage">
	{planned}
	{planned === 1 ? 'meal' : 'meals'} across {daysUsed} of 7 days
</div>

<div class="flex flex-col gap-2.5">
	{#each data.days as day (day.date)}
		{@const today = day.date === data.today}
		<section
			class="rounded-[16px] border p-3 {today
				? 'border-leaf-line bg-leaf-soft'
				: 'border-sand-dark bg-card'}"
		>
			<div class="flex items-baseline gap-2">
				<h2 class="text-[13px] font-bold">{dayName(day.date)}</h2>
				<span class="text-[11.5px] text-sage">{dayDate(day.date)}</span>
				<span class="flex-1"></span>
				{#if today}<span class="text-[10.5px] font-bold text-leaf">Today</span>{/if}
			</div>

			<div class="mt-2.5 flex flex-col gap-2">
				{#each day.entries as e (e.id)}
					<div
						class="flex items-center gap-2 rounded-[12px] border border-sand-dark bg-cream px-2.5 py-2.5"
					>
						{#if e.recipeId}
							<a href="/recipes/{e.recipeId}" class="min-w-0 flex-1 text-ink hover:text-ink">
								<div class="text-[13px] leading-tight">{e.title}</div>
								{#if recipeSub(e)}<div class="mt-1 text-[11px] text-sage">{recipeSub(e)}</div>{/if}
							</a>
						{:else}
							<div class="min-w-0 flex-1">
								<div class="text-[13px] leading-tight">{e.title}</div>
								<div class="mt-1 text-[11px] text-sage">Note · no recipe attached</div>
							</div>
						{/if}
						<form method="post" action="?/remove" use:enhance={after}>
							<input type="hidden" name="entryId" value={e.id} />
							<button
								class="icon-btn h-[30px] w-[30px] flex-none text-[14px]"
								aria-label="Remove {e.title} from {dayName(day.date)}">×</button
							>
						</form>
					</div>
				{/each}

				{#if !day.entries.length}
					<p class="px-0.5 pt-0.5 pb-1 text-[12px] text-sage">Nothing planned.</p>
				{/if}

				<button class="btn-ghost btn-sm self-start" onclick={() => openAdd(day.date)}
					>+ Add meal</button
				>
			</div>
		</section>
	{/each}
</div>

<Sheet
	bind:open={addOpen}
	title="Plan {addDay ? dayName(addDay) : ''}"
	description="Pick a saved recipe, or jot down a meal without one."
>
	<div class="flex flex-col gap-3.5">
		{#if data.recipes.length}
			<ul class="sc flex max-h-64 flex-col gap-1.5 overflow-y-auto">
				{#each data.recipes as r (r.id)}
					<li>
						<form
							method="post"
							action="?/add"
							use:enhance={() =>
								async ({ update }) => {
									await update({ reset: false });
									addOpen = false;
									await invalidateAll();
								}}
						>
							<input type="hidden" name="plannedOn" value={addDay} />
							<input type="hidden" name="recipeId" value={r.id} />
							<button
								class="w-full rounded-[12px] border border-sand-dark bg-card px-3 py-2.5 text-left hover:bg-parchment"
							>
								<div class="text-[13px] leading-tight">{r.title}</div>
								{#if recipeSub(r)}<div class="mt-1 text-[11px] text-sage">{recipeSub(r)}</div>{/if}
							</button>
						</form>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-[12.5px] text-sage">
				No saved recipes yet. <a href="/recipes/new">Add one</a>, or type a meal below.
			</p>
		{/if}

		<form
			method="post"
			action="?/add"
			class="flex flex-col gap-2"
			use:enhance={() =>
				async ({ result, update }) => {
					await update({ reset: false });
					if (result.type === 'success') {
						addOpen = false;
						noteText = '';
						await invalidateAll();
					}
				}}
		>
			<input type="hidden" name="plannedOn" value={addDay} />
			<label class="label" for="plan-note">Or type a meal</label>
			<input
				class="field"
				id="plan-note"
				name="title"
				maxlength="120"
				placeholder="e.g. Leftovers, dinner at Sam's"
				bind:value={noteText}
			/>
			<button class="btn-primary w-full" disabled={!noteText.trim()}>Add note</button>
		</form>
	</div>
</Sheet>
