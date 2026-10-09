<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { enhance } from '$app/forms';
	import Sheet from '$lib/components/Sheet.svelte';

	/**
	 * A "delete this?" sheet: one POST form with Cancel and a danger button.
	 * `children` adds fields above the buttons (a typed confirmation).
	 */
	let {
		open = $bindable(false),
		title,
		description,
		action,
		confirmLabel,
		disabled = false,
		submit,
		children
	}: {
		open?: boolean;
		title: string;
		description: string;
		action: string;
		confirmLabel: string;
		disabled?: boolean;
		submit?: SubmitFunction;
		children?: Snippet;
	} = $props();
</script>

<Sheet bind:open {title} {description}>
	<form method="post" {action} class="flex flex-col gap-3.5" use:enhance={submit}>
		{@render children?.()}
		<div class="flex gap-2.5">
			<button type="button" class="btn-secondary flex-1" onclick={() => (open = false)}
				>Cancel</button
			>
			<button class="btn-danger flex-1" {disabled}>{confirmLabel}</button>
		</div>
	</form>
</Sheet>
