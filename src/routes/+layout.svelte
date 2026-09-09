<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import AppShell from '$lib/components/AppShell.svelte';
	import Toasts from '$lib/components/Toasts.svelte';

	let { data, children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>{page.data.title ? `${page.data.title} · Pantry & Plate` : 'Pantry & Plate'}</title>
</svelte:head>

{#if data.user}
	<AppShell user={data.user} household={data.household} memberships={data.memberships}>
		{@render children()}
	</AppShell>
{:else}
	<div
		class="min-h-dvh bg-[linear-gradient(180deg,#cadce6_0%,#dde7d4_42%,#d3dec7_100%)] bg-fixed px-4 py-8 sm:py-14"
	>
		<div class="mx-auto flex max-w-md flex-col gap-5">
			<div class="text-center">
				<div class="font-display text-[26px] text-ink">Pantry &amp; Plate</div>
				<div class="mt-1 text-[12px] tracking-[0.08em] text-sage uppercase">
					Recipes · groceries · pantry
				</div>
			</div>
			{@render children()}
		</div>
	</div>
{/if}
<Toasts />
