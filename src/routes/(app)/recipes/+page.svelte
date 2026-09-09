<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RecipeCard from '$lib/components/RecipeCard.svelte';
	import Pagination from '$lib/components/Pagination.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';

	let { data } = $props();
	// svelte-ignore state_referenced_locally
	let q = $state(data.params.q);
	$effect(() => {
		q = data.params.q;
	});

	function link(changes: Record<string, string | null>) {
		const u = new URL(page.url);
		for (const [k, v] of Object.entries(changes)) {
			if (v === null || v === '') u.searchParams.delete(k);
			else u.searchParams.set(k, v);
		}
		u.searchParams.delete('page');
		return u.pathname + u.search;
	}
	const chips = $derived([
		{
			label: 'All',
			href: link({ favorites: null, scope: null, status: null }),
			on: !data.params.favorites && data.params.scope === 'all' && data.params.status === 'active'
		},
		{
			label: 'Favorites',
			href: link({ favorites: '1', scope: null, status: null }),
			on: data.params.favorites
		},
		{
			label: 'Mine',
			href: link({ favorites: null, scope: 'mine', status: null }),
			on: data.params.scope === 'mine' && data.params.status === 'active'
		},
		{
			label: 'Shared with me',
			href: link({ favorites: null, scope: 'shared', status: null }),
			on: data.params.scope === 'shared'
		},
		{
			label: 'Drafts',
			href: link({ favorites: null, scope: null, status: 'draft' }),
			on: data.params.status === 'draft'
		},
		{
			label: 'Archived',
			href: link({ favorites: null, scope: null, status: 'archived' }),
			on: data.params.status === 'archived'
		}
	]);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(
			() => goto(link({ q }), { keepFocus: true, replaceState: true, noScroll: true }),
			300
		);
	}
</script>

<PageHeader
	title="Recipes"
	subtitle="{data.list.total} {data.list.total === 1 ? 'recipe' : 'recipes'} · {data.household
		?.name ?? 'no household'}"
>
	<a
		href="/recipes/export.json"
		class="btn-ghost btn-sm hidden sm:inline-flex"
		download="recipes.json">Export</a
	>
	<a href="/recipes/new" class="btn-primary btn-sm rounded-full">+ Add</a>
</PageHeader>

<form
	method="get"
	action="/recipes"
	role="search"
	class="flex h-11 items-center gap-2 rounded-[14px] border border-sand-dark bg-linen px-3.5"
	onsubmit={(e) => {
		e.preventDefault();
		clearTimeout(searchTimer);
		goto(link({ q }));
	}}
>
	<span class="text-sage-soft" aria-hidden="true">⌕</span>
	<label class="sr-only" for="recipe-search">Search recipes</label>
	<input
		id="recipe-search"
		name="q"
		class="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-sage-soft"
		placeholder="Search recipes by title"
		bind:value={q}
		oninput={onSearchInput}
		autocomplete="off"
	/>
	{#if data.params.tag}<input type="hidden" name="tag" value={data.params.tag} />{/if}
	{#if data.params.scope !== 'all'}<input
			type="hidden"
			name="scope"
			value={data.params.scope}
		/>{/if}
	{#if data.params.favorites}<input type="hidden" name="favorites" value="1" />{/if}
	<noscript><button class="btn-secondary btn-sm">Search</button></noscript>
</form>

<div
	class="-mx-4 mt-3 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
	role="group"
	aria-label="Filters"
>
	{#each chips as c (c.label)}
		<a href={c.href} class="chip {c.on ? 'chip-on' : ''}" aria-current={c.on ? 'true' : undefined}
			>{c.label}</a
		>
	{/each}
</div>
{#if data.tags.length}
	<div
		class="-mx-4 mt-2 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
		role="group"
		aria-label="Tags"
	>
		{#each data.tags as tag (tag)}
			<a
				href={link({ tag: data.params.tag === tag ? null : tag })}
				class="chip h-7 bg-card text-[12px] {data.params.tag === tag ? 'chip-on' : ''}"
				aria-current={data.params.tag === tag ? 'true' : undefined}>#{tag}</a
			>
		{/each}
	</div>
{/if}

{#if data.list.items.length === 0}
	<EmptyState
		title={data.params.q || data.params.tag || data.params.favorites
			? 'Nothing matches'
			: 'No recipes yet'}
		body={data.params.q || data.params.tag || data.params.favorites
			? 'Try another search or filter.'
			: 'Add your first recipe by hand. Share it with your household from the recipe page.'}
	>
		<a href="/recipes/new" class="btn-primary">Add a recipe</a>
	</EmptyState>
{:else}
	<div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
		{#each data.list.items as recipe, i (recipe.id)}
			<RecipeCard {recipe} eager={i < 4} />
		{/each}
	</div>
	<Pagination current={data.list.page} pageCount={data.list.pageCount} />
{/if}
