<script lang="ts">
	import { page } from '$app/state';
	let { current, pageCount }: { current: number; pageCount: number } = $props();
	function href(p: number) {
		const u = new URL(page.url);
		u.searchParams.set('page', String(p));
		return u.pathname + u.search;
	}
</script>

{#if pageCount > 1}
	<nav class="mt-6 flex items-center justify-center gap-2" aria-label="Pages">
		<a
			class="btn-secondary btn-sm {current <= 1 ? 'pointer-events-none opacity-40' : ''}"
			href={href(Math.max(1, current - 1))}
			aria-disabled={current <= 1}>‹ Previous</a
		>
		<span class="px-2 text-[12.5px] text-sage">Page {current} of {pageCount}</span>
		<a
			class="btn-secondary btn-sm {current >= pageCount ? 'pointer-events-none opacity-40' : ''}"
			href={href(Math.min(pageCount, current + 1))}
			aria-disabled={current >= pageCount}>Next ›</a
		>
	</nav>
{/if}
