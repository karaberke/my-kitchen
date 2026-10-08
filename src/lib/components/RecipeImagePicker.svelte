<script lang="ts">
	import { onDestroy } from 'svelte';

	/**
	 * The photo field of the recipe form: a file, a link, and "remove current photo".
	 * A chosen file wins over the link, so picking one clears the link.
	 */
	let {
		image,
		removeImage = $bindable(),
		imageUrl = $bindable(),
		error = ''
	}: {
		image: { id: string; version: number } | null;
		removeImage: boolean;
		imageUrl: string;
		error?: string;
	} = $props();

	let imagePreview = $state<string | null>(null);

	onDestroy(() => {
		if (imagePreview) URL.revokeObjectURL(imagePreview);
	});

	function onFile(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (imagePreview) URL.revokeObjectURL(imagePreview);
		imagePreview = file ? URL.createObjectURL(file) : null;
		// The server uses the file and ignores the link, so clear the link here too:
		// the form must show what is going to happen.
		if (file) {
			removeImage = false;
			imageUrl = '';
		}
	}
	function onImageUrl() {
		if (imageUrl.trim()) removeImage = false;
	}
</script>

<div class="sm:col-span-2">
	<label class="label" for="image"
		>Photo <span class="font-normal text-sage">(optional, JPEG/PNG/WebP up to 5 MB)</span></label
	>
	<div class="flex items-center gap-3">
		{#if imagePreview}
			<img src={imagePreview} alt="" class="h-16 w-16 rounded-[12px] object-cover" />
		{:else if image && !removeImage}
			<img
				src="/media/{image.id}/thumb?v={image.version}"
				alt=""
				class="h-16 w-16 rounded-[12px] object-cover"
			/>
		{/if}
		<input
			class="block text-[13px] file:mr-3 file:rounded-[11px] file:border-0 file:bg-linen file:px-3 file:py-2 file:font-bold"
			id="image"
			name="image"
			type="file"
			accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
			onchange={onFile}
		/>
	</div>
	<label class="label mt-3" for="imageUrl"
		>…or a link to a picture <span class="font-normal text-sage">(optional)</span></label
	>
	<input
		class="field"
		id="imageUrl"
		name="imageUrl"
		type="url"
		inputmode="url"
		bind:value={imageUrl}
		oninput={onImageUrl}
		placeholder="https://example.com/dal.jpg"
		maxlength="2000"
	/>
	<p class="mt-1 text-[13px] text-sage">
		The picture is downloaded and kept with the recipe, so it stays when the other site changes. A
		chosen file is used instead of a link.
	</p>
	{#if error}<p class="error-text">{error}</p>{/if}
	{#if image}
		<label class="mt-2 flex items-center gap-2 text-[13px]"
			><input
				type="checkbox"
				name="removeImage"
				bind:checked={removeImage}
				class="h-4 w-4 accent-leaf"
			/> Remove current photo</label
		>
	{/if}
</div>
