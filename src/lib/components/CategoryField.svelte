<script lang="ts">
	/**
	 * A grocery category select. By default it is the category a new ingredient
	 * gets, for the sheets that can create one; `label`, `value` and `emptyOption`
	 * turn it into the category of a grocery line.
	 */
	let {
		id,
		categories,
		label = 'Category (for new ingredients)',
		value,
		emptyOption
	}: {
		id: string;
		categories: readonly string[];
		label?: string;
		value?: string;
		/** Text of a first option with an empty value, such as "Auto". */
		emptyOption?: string;
	} = $props();
</script>

<div>
	<label class="label" for={id}>{label}</label>
	<select class="field" {id} name="category" {value}
		>{#if emptyOption}<option value="">{emptyOption}</option>{/if}{#each categories as c (c)}<option
				value={c}>{c}</option
			>{/each}</select
	>
</div>
