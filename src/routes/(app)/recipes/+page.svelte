<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RecipeCard from '$lib/components/RecipeCard.svelte';
	import Pagination from '$lib/components/Pagination.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import FilterMenu from '$lib/components/FilterMenu.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import { onSuccess } from '$lib/client/enhance';

	let { data, form } = $props();
	const f = $derived(form);

	/** The current URL with one repeated `key=value` pair removed, and `page` dropped. */
	function withoutHref(key: string, value: string) {
		const u = new URL(page.url);
		u.searchParams.delete(key, value);
		u.searchParams.delete('page');
		return u.pathname + u.search;
	}
	function tagHref(tag: string | null) {
		const u = new URL(page.url);
		if (tag) u.searchParams.set('tag', tag);
		else u.searchParams.delete('tag');
		u.searchParams.delete('page');
		return u.pathname + u.search;
	}

	const groups = $derived.by(() => {
		const g = [
			{
				legend: 'Show',
				name: 'favorites',
				options: [{ value: '1', label: 'Favorites', checked: data.params.favorites }]
			},
			{
				legend: 'Owner',
				name: 'scope',
				options: [
					{ value: 'mine', label: 'Mine', checked: data.params.scope.includes('mine') },
					{
						value: 'shared',
						label: 'Shared with me',
						checked: data.params.scope.includes('shared')
					}
				]
			},
			{
				legend: 'Status',
				name: 'status',
				options: [
					{
						value: 'draft',
						label: 'Drafts',
						checked: data.params.status !== 'all' && data.params.status.includes('draft')
					},
					{
						value: 'archived',
						label: 'Archived',
						checked: data.params.status !== 'all' && data.params.status.includes('archived')
					}
				]
			}
		];
		if (data.household && data.categories.length)
			g.push({
				legend: 'Categories',
				name: 'cat',
				options: data.categories.map((c) => ({
					value: c.id,
					label: c.name,
					checked: data.params.categoryIds.includes(c.id)
				}))
			});
		return g;
	});
	const pills = $derived.by(() => {
		const out: { label: string; href: string }[] = [];
		if (data.params.favorites)
			out.push({ label: 'Favorites', href: withoutHref('favorites', '1') });
		for (const s of data.params.scope)
			out.push({
				label: s === 'mine' ? 'Mine' : 'Shared with me',
				href: withoutHref('scope', s)
			});
		if (data.params.status === 'all')
			out.push({ label: 'All statuses', href: withoutHref('status', 'all') });
		else
			for (const s of data.params.status)
				out.push({ label: s === 'draft' ? 'Drafts' : 'Archived', href: withoutHref('status', s) });
		for (const id of data.params.categoryIds) {
			const cat = data.categories.find((c) => c.id === id);
			out.push({ label: cat?.name ?? 'Category', href: withoutHref('cat', id) });
		}
		return out;
	});
	const clearHref = $derived.by(() => {
		const u = new URL(page.url);
		for (const k of ['favorites', 'scope', 'status', 'cat', 'page']) u.searchParams.delete(k);
		return u.pathname + u.search;
	});
	const hasActiveFilter = $derived(
		!!(
			data.params.q ||
			data.params.tag ||
			data.params.favorites ||
			data.params.scope.length ||
			data.params.status === 'all' ||
			data.params.status.length ||
			data.params.categoryIds.length
		)
	);

	let manageOpen = $state(false);
	let deleteConfirm = $state<string | null>(null);
	let newCategoryName = $state('');
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
	<a href="/recipes/add" class="btn-primary btn-sm rounded-full">+ Add</a>
</PageHeader>

<SearchBar
	action="/recipes"
	id="recipe-search"
	label="Search recipes"
	placeholder="Search recipes by title"
	value={data.params.q}
>
	{#if data.params.tag}<input type="hidden" name="tag" value={data.params.tag} />{/if}
	{#snippet below()}
		<div class="mt-3">
			<FilterMenu {groups} {pills} {clearHref}>
				{#if data.household}
					<button
						type="button"
						class="btn-ghost btn-sm w-full justify-start"
						onclick={() => (manageOpen = true)}>Manage categories…</button
					>
				{/if}
			</FilterMenu>
		</div>
	{/snippet}
</SearchBar>

{#if data.tags.length}
	<div
		class="-mx-4 mt-2 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
		role="group"
		aria-label="Tags"
	>
		{#each data.tags as tag (tag)}
			<a
				href={tagHref(data.params.tag === tag ? null : tag)}
				class="chip h-7 bg-card text-[12px] {data.params.tag === tag ? 'chip-on' : ''}"
				aria-current={data.params.tag === tag ? 'true' : undefined}>#{tag}</a
			>
		{/each}
	</div>
{/if}

{#if data.list.items.length === 0}
	<EmptyState
		title={hasActiveFilter ? 'Nothing matches' : 'No recipes yet'}
		body={hasActiveFilter
			? 'Try another search or filter.'
			: 'Add your first recipe by hand. Share it with your household from the recipe page.'}
	>
		<a href="/recipes/add" class="btn-primary">Add a recipe</a>
	</EmptyState>
{:else}
	<div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
		{#each data.list.items as recipe, i (recipe.id)}
			<RecipeCard {recipe} eager={i < 4} />
		{/each}
	</div>
	<Pagination current={data.list.page} pageCount={data.list.pageCount} />
{/if}

<Sheet
	bind:open={manageOpen}
	title="Manage categories"
	description="Shared by everyone in {data.household?.name ??
		'this household'}. Adding a recipe to a category shares it with the household."
	onclose={() => (deleteConfirm = null)}
>
	{#if f?.message}
		<Alert class="mb-3" kind="error">{f.message}</Alert>
	{/if}
	<ul class="card overflow-hidden">
		{#each data.categories as c (c.id)}
			<li class="divider-row flex items-center gap-2 px-3.5 py-2.5">
				{#if deleteConfirm === c.id}
					<span class="flex-1 text-[13px] text-brick-dark">Delete “{c.name}”?</span>
					<button type="button" class="btn-ghost btn-sm" onclick={() => (deleteConfirm = null)}
						>Cancel</button
					>
					<form
						method="post"
						action="?/deleteCategory"
						use:enhance={onSuccess('Category deleted.', { then: () => (deleteConfirm = null) })}
					>
						<input type="hidden" name="categoryId" value={c.id} />
						<button class="btn-danger btn-sm">Delete</button>
					</form>
				{:else}
					<form
						method="post"
						action="?/renameCategory"
						class="flex flex-1 items-center gap-2"
						use:enhance={onSuccess('Category renamed.')}
					>
						<input type="hidden" name="categoryId" value={c.id} />
						<label class="sr-only" for="cat-name-{c.id}">Category name</label>
						<input
							id="cat-name-{c.id}"
							class="field h-9 flex-1 py-1"
							name="name"
							value={c.name}
							maxlength={data.categoryNameMax}
							required
						/>
						<button class="btn-secondary btn-sm">Save</button>
					</form>
					<button type="button" class="btn-ghost btn-sm" onclick={() => (deleteConfirm = c.id)}
						>Delete</button
					>
				{/if}
			</li>
		{:else}
			<li class="px-3.5 py-3 text-[13px] text-sage">No categories yet.</li>
		{/each}
	</ul>
	<form
		method="post"
		action="?/createCategory"
		class="mt-3 flex items-center gap-2"
		use:enhance={onSuccess('Category created.', {
			reset: true,
			then: () => (newCategoryName = '')
		})}
	>
		<label class="sr-only" for="new-cat-name">New category name</label>
		<input
			id="new-cat-name"
			class="field h-9 flex-1 py-1"
			name="name"
			placeholder="New category"
			bind:value={newCategoryName}
			maxlength={data.categoryNameMax}
			required
		/>
		<button class="btn-primary btn-sm">Add</button>
	</form>
</Sheet>
