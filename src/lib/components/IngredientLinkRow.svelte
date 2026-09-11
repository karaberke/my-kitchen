<script lang="ts">
	/**
	 * One unlinked ingredient name on the pantry links screen. The row owns its
	 * own choice, so a new list from the server simply builds new rows.
	 */
	import IngredientAutocomplete from '$lib/components/IngredientAutocomplete.svelte';
	import type { UnlinkedGroup } from '$lib/server/ingredient-links';

	let {
		group,
		index,
		onchoice
	}: {
		group: UnlinkedGroup;
		index: number;
		onchoice: (key: string, picked: boolean) => void;
	} = $props();

	// The proposal starts selected; ✕ in the combobox refuses it. The row owns
	// its choice after mount; a new list from the server builds new rows.
	/* svelte-ignore state_referenced_locally */
	let ingredientId = $state<string | null>(group.proposal?.ingredientId ?? null);
	/* svelte-ignore state_referenced_locally */
	let identityLabel = $state<string | null>(group.proposal?.name ?? null);
	let createIdentity = $state(false);
	/* svelte-ignore state_referenced_locally */
	let search = $state(group.name);

	$effect(() => {
		onchoice(group.key, !!ingredientId || createIdentity);
	});
</script>

<li class="card p-3.5">
	<input type="hidden" name="link.{index}.name" value={group.name} />
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<span class="text-[14px] font-bold">{group.name}</span>
		<span class="text-[11.5px] text-sage">
			{group.rowCount}
			{group.rowCount === 1 ? 'row' : 'rows'} · {group.recipeTitles.join(', ')}
		</span>
	</div>
	{#if group.proposal}
		<p class="mt-1 text-[11.5px] text-sage">
			Proposed: <strong>{group.proposal.name}</strong>
			{#if group.proposal.matchedOn === 'alias'}· through the other name “{group.proposal
					.matchedText}”{/if}
		</p>
	{/if}
	<div class="mt-2">
		<label class="sr-only" for="link-{index}">Pantry ingredient for {group.name}</label>
		<IngredientAutocomplete
			bind:name={search}
			bind:ingredientId
			bind:identityLabel
			bind:createIdentity
			inputId="link-{index}"
			fieldName="link.{index}.match.name"
			placeholder="Search the pantry catalog"
		/>
	</div>
</li>
