<script lang="ts">
	/** The category a new ingredient gets, for the sheets that can create one. */
	let { id, categories }: { id: string; categories: readonly string[] } = $props();
</script>

<div>
	<label class="label" for={id}>Category (for new ingredients)</label>
	<select class="field" {id} name="category"
		>{#each categories as c (c)}<option value={c}>{c}</option>{/each}</select
	>
</div>
