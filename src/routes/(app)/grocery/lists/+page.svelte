<script lang="ts">
	import NewListForm from '$lib/components/NewListForm.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { fmtDateTime } from '$lib/client/format';
	let { data } = $props();
	const label: Record<string, string> = {
		draft: 'Draft',
		shopping: 'Shopping',
		completed: 'Completed'
	};
	const pill: Record<string, string> = {
		draft: 'bg-honey-soft text-honey-dark',
		shopping: 'bg-leaf-soft text-leaf',
		completed: 'bg-linen text-sage'
	};
</script>

<PageHeader
	title="Grocery lists"
	subtitle="{data.household?.name} · drafts, trips in progress and archived trips"
	back="/grocery"
/>
<NewListForm
	class="mb-4"
	inputClass="flex-1"
	placeholder="New list name (e.g. Party shop)"
	submitLabel="New draft"
	errorClass="mb-3"
/>
<p class="mb-3 text-[12px] text-sage">
	Separate lists do not reserve pantry stock from each other; each draft is recalculated from
	current stock when you open it.
</p>
<ul class="card overflow-hidden">
	{#each data.lists as l (l.id)}
		<li class="divider-row">
			<a
				href="/grocery/{l.id}"
				class="flex items-center gap-3 px-3.5 py-3 text-[13.5px] hover:bg-parchment"
				><span class="pill {pill[l.status]}">{label[l.status]}</span><span
					class="flex-1 font-semibold">{l.name}</span
				><span class="text-sage"
					>{l.status === 'completed' ? `${l.totalCount} items` : `${l.pendingCount} pending`} · {fmtDateTime(
						l.completedAt ?? l.updatedAt
					)}</span
				></a
			>
		</li>
	{:else}
		<li class="px-3.5 py-6 text-center text-[13px] text-sage">No lists yet.</li>
	{/each}
</ul>
