<script lang="ts">
	import { INGREDIENT_MATCH_MAX_NAMES } from '$lib/shared/recipe-input';
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import IngredientLinkRow from '$lib/components/IngredientLinkRow.svelte';
	import { pushToast } from '$lib/client/toast.svelte';
	import { remoteErrorMessage } from '$lib/client/remote';
	import { assistantIngredientMatch } from '$lib/remote/ingredients.remote';
	import type { IngredientSuggestion } from '$lib/server/ingredients';

	let { data, form } = $props();

	// Each row reports its own choice under its key; stale keys are ignored.
	let picked = $state<Record<string, boolean>>({});
	const onchoice = (key: string, on: boolean) => (picked[key] = on);
	const selected = $derived(data.groups.filter((g) => picked[g.key]).length);
	const errorMessage = $derived(
		form && 'message' in form ? (form as { message?: string }).message : null
	);

	// Assistant suggestions, by group key. They only prefill rows; the Link button decides.
	const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ');
	let asked = $state<Record<string, boolean>>({});
	let suggestions = $state<Record<string, IngredientSuggestion>>({});
	let suggesting = $state(false);
	let suggestError = $state<string | null>(null);
	let suggestNote = $state<string | null>(null);
	const askable = $derived(data.groups.filter((g) => !g.proposal && !asked[g.key]));
	async function suggest() {
		if (suggesting) return;
		const batch = askable.slice(0, INGREDIENT_MATCH_MAX_NAMES);
		suggesting = true;
		suggestError = null;
		suggestNote = null;
		try {
			const { picks } = await assistantIngredientMatch({
				names: batch.map((g) => cleanName(g.name))
			});
			let found = 0;
			for (const g of batch) {
				asked[g.key] = true;
				const pick = picks[cleanName(g.name)];
				if (pick) {
					suggestions[g.key] = pick;
					found++;
				}
			}
			suggestNote = found
				? `The assistant suggested ${found} of ${batch.length}. Check each row, then press the button at the end.`
				: 'The assistant is not sure about any of these. Choose a match yourself.';
		} catch (err) {
			suggestError = remoteErrorMessage(err, 'Could not reach the server. Check your connection.');
		} finally {
			suggesting = false;
		}
	}
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
	{#if data.aiEnabled && (askable.length > 0 || suggesting)}
		<div class="mt-3">
			<button
				type="button"
				class="btn-secondary btn-sm"
				onclick={suggest}
				disabled={suggesting || askable.length === 0}
				aria-busy={suggesting}
			>
				{suggesting ? 'Asking the assistant…' : 'Suggest with assistant'}
			</button>
		</div>
	{/if}
	<div class="mt-2" aria-live="polite">
		{#if suggesting}
			<p class="text-[12.5px] text-sage">
				Asking the assistant about {Math.min(askable.length, INGREDIENT_MATCH_MAX_NAMES)} names… this
				can take a minute.
			</p>
		{/if}
		{#if suggestError}<Alert kind="error">{suggestError}</Alert>{/if}
		{#if suggestNote}<p class="text-[12.5px] text-sage">{suggestNote}</p>{/if}
	</div>
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
				<IngredientLinkRow group={g} index={i} suggestion={suggestions[g.key] ?? null} {onchoice} />
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
