<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		title,
		body = '',
		children
	}: { title: string; body?: string; children?: Snippet } = $props();
</script>

<div
	class="mt-4 rounded-[18px] border border-dashed border-[#d6cfb6] bg-parchment px-5 py-8 text-center"
>
	<div class="font-display text-[16px]">{title}</div>
	{#if body}<p class="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-sage">{body}</p>{/if}
	{#if children}<div class="mt-4 flex justify-center gap-2">{@render children()}</div>{/if}
</div>
