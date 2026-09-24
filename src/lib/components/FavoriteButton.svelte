<script lang="ts">
	import { enhance } from '$app/forms';

	let {
		recipeId,
		isFavorite,
		action,
		variant = 'icon'
	}: {
		/** Only needed when the action does not already scope to a recipe via the route. */
		recipeId?: string;
		isFavorite: boolean;
		action: string;
		variant?: 'icon' | 'text';
	} = $props();
	let fav = $derived(isFavorite);
</script>

<form
	method="post"
	{action}
	class={variant === 'icon' ? 'relative z-10 -mt-1 -mr-1' : undefined}
	use:enhance={() => {
		fav = !fav;
		return async ({ result, update }) => {
			if (result.type !== 'success') fav = !fav;
			await update({ reset: false, invalidateAll: false });
		};
	}}
>
	{#if recipeId}<input type="hidden" name="recipeId" value={recipeId} />{/if}
	<input type="hidden" name="favorite" value={fav ? '0' : '1'} />
	{#if variant === 'icon'}
		<button
			class="flex h-9 w-9 items-center justify-center rounded-full text-[16px] {fav
				? 'text-honey'
				: 'text-fog hover:text-honey'}"
			aria-pressed={fav}
			aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}>{fav ? '★' : '☆'}</button
		>
	{:else}
		<button class="btn-secondary btn-sm" aria-pressed={fav}
			>{fav ? '★ Favorited' : '☆ Favorite'}</button
		>
	{/if}
</form>
