<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		title,
		subtitle = '',
		back = '',
		children
	}: { title: string; subtitle?: string; back?: string; children?: Snippet } = $props();
</script>

<div class="mb-4 flex items-center gap-3 md:mb-6">
	{#if back}
		<a href={back} class="icon-btn no-print flex-none text-[18px]" aria-label="Back">‹</a>
	{/if}
	<div class="min-w-0 flex-1">
		<h1 class="truncate text-[22px] leading-tight md:text-[26px]">{title}</h1>
		{#if subtitle}<div class="mt-0.5 text-[12px] text-sage">{subtitle}</div>{/if}
	</div>
	{#if children}<div class="no-print flex flex-none items-center gap-2">
			{@render children()}
		</div>{/if}
</div>
