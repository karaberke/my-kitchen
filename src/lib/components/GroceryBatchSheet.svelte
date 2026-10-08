<script lang="ts">
	import { enhance } from '$app/forms';
	import Sheet from '$lib/components/Sheet.svelte';
	import { fmtNum } from '$lib/client/format';
	import type { MutateEnhance } from '$lib/client/enhance';
	import type { BatchView } from '$lib/server/grocery';

	/** The "Planned batch" sheet of the grocery list page; open while `batch` is set. */
	let {
		batch,
		mutate,
		onclose
	}: { batch: BatchView | null; mutate: MutateEnhance; onclose: () => void } = $props();
</script>

<Sheet
	open={!!batch}
	{onclose}
	title="Planned batch"
	description={batch ? `${batch.recipeTitle} · base ${fmtNum(batch.baseServings)} servings` : ''}
>
	{#if batch}
		<form method="post" action="?/batch" class="flex flex-col gap-3.5" use:enhance={mutate()}>
			<input type="hidden" name="batchId" value={batch.id} />
			<div>
				<label class="label" for="batch-servings">Servings</label>
				<input
					class="field"
					id="batch-servings"
					name="servings"
					inputmode="decimal"
					value={batch.servings}
				/>
			</div>
			{#if batch.requirements.some((r) => r.optional)}
				<fieldset>
					<legend class="label">Optional ingredients to include</legend>
					{#each batch.requirements.filter((r) => r.optional) as r (r.id)}
						<label class="flex min-h-9 items-center gap-2.5 text-[13px]"
							><input
								type="checkbox"
								name="includeOptional"
								value={r.position}
								checked={r.include}
								class="h-5 w-5 accent-leaf"
							/>
							{r.name}</label
						>
					{/each}
				</fieldset>
			{/if}
			<div class="flex gap-2.5">
				<button class="btn-primary flex-1">Save</button>
				<button class="btn-danger flex-1" name="remove" value="1">Remove from plan</button>
			</div>
		</form>
	{/if}
</Sheet>
