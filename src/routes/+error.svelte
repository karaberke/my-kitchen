<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="mx-auto max-w-md px-4 py-16 text-center">
	<div class="font-display text-[40px] text-sage-soft">{page.status}</div>
	<h1 class="mt-2 text-[20px]">{page.status === 404 ? 'Nothing here' : 'Something went wrong'}</h1>
	<p class="mt-3 text-[14px] leading-relaxed text-sage">{page.error?.message ?? 'Unknown error'}</p>
	{#if page.error?.code}
		<p class="mt-2 font-mono text-[11px] text-sage-soft">ref {page.error.code}</p>
	{/if}
	<a href="/recipes" class="btn-secondary mt-6">Back to recipes</a>
</div>
