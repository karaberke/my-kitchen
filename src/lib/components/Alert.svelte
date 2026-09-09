<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		kind = 'info',
		children
	}: { kind?: 'info' | 'warn' | 'error' | 'success'; children: Snippet } = $props();
	const styles = {
		info: 'bg-sky/60 border-mist text-ink-soft',
		warn: 'bg-honey-soft border-honey-line text-honey-dark',
		error: 'bg-brick-soft border-brick-line text-brick-dark',
		success: 'bg-leaf-soft border-leaf-line text-leaf-dark'
	};
</script>

<div
	class="rounded-[14px] border px-3.5 py-3 text-[13px] leading-relaxed {styles[kind]}"
	role={kind === 'error' ? 'alert' : 'status'}
>
	{@render children()}
</div>
