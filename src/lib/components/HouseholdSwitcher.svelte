<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { clearToasts, pushToast } from '$lib/client/toast.svelte';

	let {
		household,
		memberships,
		compact = false
	}: {
		household: { id: string; name: string; role: string } | null;
		memberships: { householdId: string; name: string; role: string; memberCount: number }[];
		compact?: boolean;
	} = $props();

	let form: HTMLFormElement | undefined = $state();
</script>

{#if memberships.length <= 1}
	<div
		class="truncate text-[11.5px] text-sage {compact
			? 'max-w-40 rounded-full bg-linen px-3 py-1.5 font-semibold'
			: ''}"
		title={household?.name}
	>
		{household?.name ?? 'No household'}
	</div>
{:else}
	<form
		bind:this={form}
		method="post"
		action="/household?/switch"
		use:enhance={() => {
			return async ({ result, update }) => {
				clearToasts();
				await update({ reset: false });
				if (result.type === 'success') {
					await invalidateAll();
					pushToast(
						`Switched household. Pantry and lists now show ${form?.querySelector('select')?.selectedOptions[0]?.text ?? 'the other household'}.`,
						{ kind: 'success' }
					);
				}
			};
		}}
	>
		<label class="sr-only" for="household-switch-{compact ? 'm' : 'd'}">Active household</label>
		<select
			id="household-switch-{compact ? 'm' : 'd'}"
			name="householdId"
			class="max-w-44 truncate rounded-full border border-sand-dark bg-linen py-1.5 pr-7 pl-3 text-[12px] font-semibold text-moss {compact
				? ''
				: 'w-full'}"
			value={household?.id}
			onchange={() => form?.requestSubmit()}
		>
			{#each memberships as m (m.householdId)}
				<option value={m.householdId}>{m.name}</option>
			{/each}
		</select>
		<noscript><button class="btn-secondary btn-sm mt-1">Switch</button></noscript>
	</form>
{/if}
