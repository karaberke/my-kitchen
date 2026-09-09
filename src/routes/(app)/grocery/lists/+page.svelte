<script lang="ts">
	import { enhance } from '$app/forms';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { fmtDateTime } from '$lib/client/format';
	let { data, form } = $props();
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
<form method="post" action="?/create" use:enhance class="mb-4 flex gap-2">
	<input
		class="field flex-1"
		name="name"
		placeholder="New list name (e.g. Party shop)"
		maxlength="80"
		aria-label="List name"
	/>
	<button class="btn-primary">New draft</button>
</form>
{#if form?.message}<p class="error-text mb-3">{form.message}</p>{/if}
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
