<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RecipeForm from '$lib/components/RecipeForm.svelte';
	let { data, form } = $props();
</script>

<PageHeader
	title="New recipe"
	subtitle="Enter it by hand. Save a draft any time."
	back="/recipes"
/>
{#key form?.input}
	<RecipeForm
		mode="new"
		initial={form?.input ?? data.initial}
		errors={form?.errors ?? {}}
		message={form?.message ?? ''}
	/>
{/key}
