<script lang="ts">
	import type { Dec } from '$lib/shared/decimal';
	import { displayQuantity } from '$lib/shared/display-units';
	import type { Convention } from '$lib/shared/units';
	import { scaleStepText, type StepIngredient } from '$lib/shared/step-amounts';
	import { unitSystem } from '$lib/client/unit-system.svelte';

	/**
	 * One step's text with the amounts that belong to an ingredient scaled to
	 * the servings shown, written like the ingredient list. A changed amount is
	 * bold and its title gives what the recipe wrote.
	 */
	let {
		text,
		ingredients,
		base,
		servings,
		convention
	}: {
		text: string;
		ingredients: StepIngredient[];
		base: Dec;
		servings: Dec;
		convention: Convention;
	} = $props();

	const parts = $derived(
		scaleStepText(
			text,
			ingredients,
			base,
			servings,
			// Reading unitSystem here re-renders the step on toggle, as the list does.
			(amount, unit) => displayQuantity(amount, unit, unitSystem.value, convention).text
		)
	);
</script>

{#each parts as part, i (i)}{#if part.original}<strong
			class="font-semibold"
			title="{part.original} in the recipe">{part.text}</strong
		>{:else}{part.text}{/if}{/each}
