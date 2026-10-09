<script lang="ts">
	import type { Snippet } from 'svelte';
	import { debouncedSubmit } from '$lib/client/debounced-search';

	/**
	 * The as-you-type search form of a list page: a GET form that resubmits after
	 * a pause in typing. `children` renders inside the box (hidden inputs that
	 * carry the other filters); `below` renders in the same form under the box.
	 */
	let {
		action,
		id,
		label,
		placeholder,
		value,
		children,
		below
	}: {
		action: string;
		id: string;
		label: string;
		placeholder: string;
		value: string;
		children?: Snippet;
		below?: Snippet;
	} = $props();

	let q = $derived(value);
	const submit = debouncedSubmit();
</script>

<form
	method="get"
	{action}
	role="search"
	data-sveltekit-keepfocus
	data-sveltekit-noscroll
	data-sveltekit-replacestate
	onsubmit={() => submit.cancel()}
>
	<div class="flex h-11 items-center gap-2 rounded-[14px] border border-sand-dark bg-linen px-3.5">
		<span class="text-sage-soft" aria-hidden="true">⌕</span>
		<label class="sr-only" for={id}>{label}</label>
		<input
			{id}
			name="q"
			class="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-sage-soft"
			{placeholder}
			bind:value={q}
			oninput={(e) => submit(e.currentTarget.form!)}
			autocomplete="off"
		/>
		{@render children?.()}
		<noscript><button class="btn-secondary btn-sm">Search</button></noscript>
	</div>
	{@render below?.()}
</form>
