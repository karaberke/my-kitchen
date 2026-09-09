<script lang="ts">
	import { enhance } from '$app/forms';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import Sheet from '$lib/components/Sheet.svelte';

	let { data, form } = $props();
	let newOpen = $state(false);
</script>

<PageHeader
	title="Households"
	subtitle="Pantry and grocery lists belong to the active household. Recipes are yours everywhere."
>
	<button class="btn-secondary btn-sm" onclick={() => (newOpen = true)}>Create household</button>
</PageHeader>

{#if form?.message}<div class="mb-3"><Alert kind="error">{form.message}</Alert></div>{/if}

{#if data.memberships.length}
	<ul class="flex flex-col gap-2">
		{#each data.memberships as m (m.householdId)}
			{@const active = m.householdId === data.household?.id}
			<li>
				<a
					href="/household/{m.householdId}"
					class="flex items-center gap-2.5 rounded-[14px] border px-3.5 py-3 transition-colors {active
						? 'border-leaf-line bg-leaf-soft'
						: 'border-sand-dark bg-cream hover:bg-parchment'}"
				>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-[13.5px] font-semibold">{m.name}</span>
						<span class="block text-[11.5px] text-sage">
							{m.memberCount}
							{m.memberCount === 1 ? 'member' : 'members'} · you are {m.role === 'owner'
								? 'an owner'
								: 'a member'}{active ? ' · active' : ''}
						</span>
					</span>
					<span class="text-[12px] text-sage" aria-hidden="true">›</span>
				</a>
			</li>
		{/each}
	</ul>
{:else}
	<p class="text-[13px] text-sage">
		You are not in any household yet. Create one to start a pantry and grocery lists.
	</p>
{/if}

<Sheet
	bind:open={newOpen}
	title="Create a household"
	description="A new household starts with an empty pantry and grocery list. Your recipes stay with you."
>
	<form method="post" action="?/create" class="flex flex-col gap-3.5" use:enhance>
		<div>
			<label class="label" for="hh-name">Household name</label>
			<input
				class="field"
				id="hh-name"
				name="name"
				required
				minlength="2"
				maxlength="60"
				placeholder="e.g. Lake House"
			/>
		</div>
		<button class="btn-primary w-full">Create household</button>
	</form>
</Sheet>
