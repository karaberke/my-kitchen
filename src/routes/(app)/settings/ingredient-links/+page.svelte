<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import IngredientLinkRow from '$lib/components/IngredientLinkRow.svelte';
	import { pushToast } from '$lib/client/toast.svelte';

	let { data, form } = $props();

	// Each row reports its own choice under its key; stale keys are ignored.
	let picked = $state<Record<string, boolean>>({});
	const onchoice = (key: string, on: boolean) => (picked[key] = on);
	const selected = $derived(data.groups.filter((g) => picked[g.key]).length);
	const errorMessage = $derived(
		form && 'message' in form ? (form as { message?: string }).message : null
	);
</script>

<PageHeader
	title="Pantry links"
	subtitle="Ingredients in your recipes that the pantry cannot recognise"
	back="/settings"
/>

{#if errorMessage}<div class="mt-3"><Alert kind="error">{errorMessage}</Alert></div>{/if}

{#if data.groups.length === 0}
	<EmptyState
		title="Everything is linked"
		body="Each ingredient in your recipes points at a pantry ingredient, so the recipe pages can show what you have in stock."
	>
		<a href="/recipes" class="btn-primary">Back to recipes</a>
	</EmptyState>
{:else}
	<p class="mt-3 text-[13px] text-sage">
		The app proposes a match for each name. Nothing changes until you push the button at the end.
		Push ✕ on a row to leave it as it is.
	</p>
	<form
		method="post"
		action="?/link"
		use:enhance={() =>
			async ({ result, update }) => {
				await update({ reset: false });
				if (result.type === 'success' && result.data?.ok) {
					const { rows, recipes } = result.data as { rows: number; recipes: number };
					pushToast(
						rows
							? `Linked ${rows} ${rows === 1 ? 'ingredient' : 'ingredients'} in ${recipes} ${recipes === 1 ? 'recipe' : 'recipes'}.`
							: 'Nothing left to link.',
						{ kind: 'success' }
					);
					await invalidate('app:ingredient-links');
				}
			}}
	>
		<ul class="mt-4 grid gap-3">
			{#each data.groups as g, i (g.key)}
				<IngredientLinkRow group={g} index={i} {onchoice} />
			{/each}
		</ul>
		<div class="sticky bottom-0 mt-4 bg-parchment/95 py-3">
			<button class="btn-primary w-full rounded-[16px]" disabled={selected === 0}>
				Link {selected}
				{selected === 1 ? 'ingredient' : 'ingredients'}
			</button>
		</div>
	</form>
{/if}
