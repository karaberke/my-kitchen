<script lang="ts">
	import { setUnitSystem, unitSystem } from '$lib/client/unit-system.svelte';
	import { UNIT_SYSTEMS, UNIT_SYSTEM_LABEL } from '$lib/shared/display-units';

	let { label = 'Units' }: { label?: string } = $props();
</script>

<div
	class="no-print flex items-center gap-1 rounded-[14px] bg-linen p-1"
	role="group"
	aria-label={label}
>
	{#each UNIT_SYSTEMS as sys (sys)}
		<button
			type="button"
			class="h-9 rounded-[11px] px-3 text-[12.5px] font-semibold transition-colors {unitSystem.value ===
			sys
				? 'bg-cream text-ink shadow-sm'
				: 'text-sage hover:bg-cream/60'}"
			aria-pressed={unitSystem.value === sys}
			onclick={() => setUnitSystem(sys)}
		>
			{UNIT_SYSTEM_LABEL[sys]}
		</button>
	{/each}
</div>
