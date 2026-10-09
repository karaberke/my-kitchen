<script lang="ts">
	import { enhance } from '$app/forms';

	/**
	 * Creates a grocery list: the one `?/create` action of /grocery, posted from
	 * either page. On another path than /grocery the page `form` prop never gets
	 * the failure, so a page there passes `errorClass` and the form shows it.
	 */
	let {
		placeholder,
		submitLabel,
		class: className = '',
		inputClass,
		errorClass
	}: {
		placeholder: string;
		submitLabel: string;
		class?: string;
		inputClass: string;
		errorClass?: string;
	} = $props();
	let error = $state<string | null>(null);
</script>

<form
	method="post"
	action="/grocery?/create"
	use:enhance={() =>
		async ({ result, update }) => {
			if (errorClass === undefined) return update();
			error =
				result.type === 'failure'
					? String(result.data?.message ?? 'Could not create the list')
					: null;
			if (result.type !== 'failure') await update();
		}}
	class="flex gap-2 {className}"
>
	<input
		class="field {inputClass}"
		name="name"
		{placeholder}
		maxlength="80"
		aria-label="List name"
	/>
	<button class="btn-primary">{submitLabel}</button>
</form>
{#if error}<p class="error-text {errorClass}">{error}</p>{/if}
