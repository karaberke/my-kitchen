<script lang="ts">
	import NewListForm from '$lib/components/NewListForm.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { fmtDateTime } from '$lib/client/format';
	let { data, form } = $props();
</script>

<PageHeader title="Grocery list" subtitle="{data.household?.name} · shared" />
<EmptyState
	title="No open list"
	body="Start a draft, add recipes with servings, review what is missing from the pantry, then start shopping."
>
	<NewListForm inputClass="w-44" placeholder="Weekly shop" submitLabel="Start a list" />
</EmptyState>
{#if form?.message}<p class="error-text mt-2 text-center">{form.message}</p>{/if}
{#if data.lists.length}
	<h2 class="mt-8 mb-2 text-[16px]">Past trips</h2>
	<ul class="card overflow-hidden">
		{#each data.lists as l (l.id)}
			<li class="divider-row">
				<a
					href="/grocery/{l.id}"
					class="flex items-center gap-3 px-3.5 py-3 text-[13.5px] hover:bg-parchment"
					><span class="flex-1 font-semibold">{l.name}</span><span class="text-sage"
						>{l.totalCount} items · {fmtDateTime(l.completedAt ?? l.updatedAt)}</span
					></a
				>
			</li>
		{/each}
	</ul>
{/if}
