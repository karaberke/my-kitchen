<script lang="ts">
	import { enhance } from '$app/forms';
	import type { RecipeCard } from '$lib/server/recipes';
	import { fmtMinutes, fmtNum } from '$lib/client/format';

	let { recipe, eager = false }: { recipe: RecipeCard; eager?: boolean } = $props();
	// svelte-ignore state_referenced_locally
	let fav = $state(recipe.isFavorite);
	$effect(() => {
		fav = recipe.isFavorite;
	});
	const meta = $derived(
		[
			recipe.prepMinutes ? `${fmtMinutes(recipe.prepMinutes)} prep` : '',
			recipe.cookMinutes ? `${fmtMinutes(recipe.cookMinutes)} cook` : '',
			recipe.baseServings ? `${fmtNum(recipe.baseServings)} servings` : recipe.yieldNote
		]
			.filter(Boolean)
			.join(' · ')
	);
</script>

<article class="card relative flex gap-3 p-2.5 transition-colors hover:border-[#c6c9a8]">
	<a href="/recipes/{recipe.id}" class="absolute inset-0 rounded-[18px]" aria-label={recipe.title}
		><span class="sr-only">{recipe.title}</span></a
	>
	<div
		class="h-[76px] w-[76px] flex-none overflow-hidden rounded-[13px] bg-[linear-gradient(155deg,#cfe1ea_0%,#dee9d7_52%,#c9dabd_100%)]"
	>
		{#if recipe.image}
			<img
				src="/media/{recipe.image.id}/thumb?v={recipe.image.version}"
				alt=""
				width={recipe.image.thumb.width}
				height={recipe.image.thumb.height}
				loading={eager ? 'eager' : 'lazy'}
				decoding="async"
				class="h-full w-full object-cover"
			/>
		{:else}
			<div
				class="flex h-full w-full items-center justify-center font-mono text-[8.5px] leading-tight text-sage-soft"
				aria-hidden="true"
			>
				no<br />photo
			</div>
		{/if}
	</div>
	<div class="min-w-0 flex-1 py-0.5">
		<div class="flex items-start gap-2">
			<h3 class="flex-1 text-[14.5px] leading-snug">{recipe.title}</h3>
			<form
				method="post"
				action="/recipes?/favorite"
				class="relative z-10 -mt-1 -mr-1"
				use:enhance={() => {
					fav = !fav;
					return async ({ result, update }) => {
						if (result.type !== 'success') fav = !fav;
						await update({ reset: false, invalidateAll: false });
					};
				}}
			>
				<input type="hidden" name="recipeId" value={recipe.id} />
				<input type="hidden" name="favorite" value={fav ? '0' : '1'} />
				<button
					class="flex h-9 w-9 items-center justify-center rounded-full text-[16px] {fav
						? 'text-honey'
						: 'text-fog hover:text-honey'}"
					aria-pressed={fav}
					aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}>{fav ? '★' : '☆'}</button
				>
			</form>
		</div>
		{#if meta}<div class="mt-0.5 text-[11.5px] text-sage">{meta}</div>{/if}
		<div class="mt-2 flex flex-wrap gap-1.5">
			{#if recipe.status === 'draft'}
				<span class="pill bg-honey-soft text-honey-dark">Draft</span>
			{:else if recipe.status === 'archived'}
				<span class="pill bg-linen text-sage">Archived</span>
			{/if}
			{#if !recipe.isOwner}
				<span class="pill bg-leaf-soft text-leaf">Shared by {recipe.ownerName}</span>
			{/if}
			{#each recipe.tags.slice(0, 3) as tag (tag)}
				<span class="pill bg-linen text-moss-soft">{tag}</span>
			{/each}
		</div>
	</div>
</article>
