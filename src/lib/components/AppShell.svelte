<script lang="ts">
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import type { Snippet } from 'svelte';
	import HouseholdSwitcher from './HouseholdSwitcher.svelte';
	import { initials } from '$lib/client/format';

	let {
		user,
		household,
		memberships,
		children
	}: {
		user: { name: string; email: string };
		household: { id: string; name: string; role: string } | null;
		memberships: { householdId: string; name: string; role: string; memberCount: number }[];
		children: Snippet;
	} = $props();

	const tabs = [
		{ href: '/recipes', label: 'Recipes', icon: '❏' },
		{ href: '/plan', label: 'Plan', icon: '▦' },
		{ href: '/grocery', label: 'Grocery', icon: '☑' },
		{ href: '/pantry', label: 'Pantry', icon: '▤' },
		{ href: '/household', label: 'Household', icon: '⌂' },
		{ href: '/settings', label: 'Settings', icon: '⚙' }
	];
	const isActive = (href: string) =>
		page.url.pathname === href || page.url.pathname.startsWith(href + '/');
</script>

<div class="flex min-h-dvh">
	<a
		href="#main"
		class="sr-only-focusable fixed top-2 left-2 z-50 rounded-md bg-ink px-3 py-2 text-cream"
		>Skip to content</a
	>

	<!-- Desktop sidebar -->
	<aside
		class="no-print sticky top-0 hidden h-dvh w-60 flex-none flex-col border-r border-sand bg-parchment px-3.5 py-5 md:flex"
	>
		<a href="/recipes" class="font-display px-2 text-[18px] text-ink">My Kitchen</a>
		<div class="px-2 pt-1 pb-4">
			<HouseholdSwitcher {household} {memberships} />
		</div>
		<nav aria-label="Main" class="flex flex-col gap-1">
			{#each tabs as t (t.href)}
				<a
					href={t.href}
					aria-current={isActive(t.href) ? 'page' : undefined}
					class="flex h-10.5 items-center gap-2.5 rounded-xl px-3 text-[13.5px] font-bold transition-colors {isActive(
						t.href
					)
						? 'bg-leaf-soft text-leaf'
						: 'text-moss-soft hover:bg-linen'}"
				>
					<span class="w-5 text-center text-[15px]" aria-hidden="true">{t.icon}</span>
					<span>{t.label}</span>
				</a>
			{/each}
		</nav>
		<div class="flex-1"></div>
		<div class="flex items-center gap-2.5 rounded-[14px] border border-sand bg-card p-2.5">
			<span
				class="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-leaf-soft text-[11.5px] font-bold text-moss"
				>{initials(user.name)}</span
			>
			<div class="min-w-0 flex-1">
				<div class="truncate text-[12px] font-semibold">{user.name}</div>
				<div class="truncate text-[10.5px] text-sage">{user.email}</div>
			</div>
			<form method="post" action="/logout" use:enhance>
				<button class="icon-btn h-8 w-8" title="Sign out" aria-label="Sign out">⇥</button>
			</form>
		</div>
	</aside>

	<div class="flex min-w-0 flex-1 flex-col">
		<!-- Mobile header -->
		<header class="no-print flex items-center justify-between gap-3 px-4 pt-3 pb-1 md:hidden">
			<a href="/recipes" class="font-display text-[17px]">My Kitchen</a>
			<HouseholdSwitcher {household} {memberships} compact />
		</header>

		<main
			id="main"
			class="mx-auto w-full max-w-5xl flex-1 px-4 pt-2 pb-28 sm:px-6 md:px-8 md:pt-6 md:pb-12"
		>
			{@render children()}
		</main>

		<!-- Mobile tab bar -->
		<nav
			aria-label="Main"
			class="no-print fixed inset-x-0 bottom-0 z-30 flex h-[calc(64px+env(safe-area-inset-bottom))] items-start border-t border-sand bg-cream/95 px-1 pt-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
		>
			{#each tabs as t (t.href)}
				<a
					href={t.href}
					aria-current={isActive(t.href) ? 'page' : undefined}
					class="flex h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[10.5px] font-bold {isActive(
						t.href
					)
						? 'text-leaf'
						: 'text-moss-soft'}"
				>
					<span class="text-[17px] leading-none" aria-hidden="true">{t.icon}</span>
					<span>{t.label}</span>
				</a>
			{/each}
		</nav>
	</div>
</div>
