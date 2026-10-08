<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import RecipeForm from '$lib/components/RecipeForm.svelte';
	let { data, form } = $props();
</script>

<PageHeader title="Edit recipe" subtitle={data.initial.title} back="/recipes/{data.recipeId}" />
{#if form?.aiFixed}
	<div class="mb-3">
		<Alert kind="info"
			>The assistant tidied this recipe. Nothing is saved yet. Check it, then save.</Alert
		>
	</div>
{/if}
{#key form?.input}
	<RecipeForm
		mode="edit"
		initial={form?.input ?? data.initial}
		identityLabels={data.identityLabels}
		errors={form?.errors ?? {}}
		message={form?.message ?? ''}
		conflict={!!form?.conflict}
		expectedRevision={form?.input?.expectedRevision ?? data.revision}
		image={data.image}
		assistant={data.aiEnabled}
		proposed={!!form?.aiFixed}
	/>
{/key}
