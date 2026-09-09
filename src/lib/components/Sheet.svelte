<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Accessible dialog: bottom sheet on phones, centered card on larger screens.
	 * Uses the native <dialog> element for focus trapping and Escape handling.
	 */
	let {
		open = $bindable(false),
		title,
		description = '',
		children,
		onclose
	}: {
		open?: boolean;
		title: string;
		description?: string;
		children: Snippet;
		onclose?: () => void;
	} = $props();

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});

	function close() {
		open = false;
		onclose?.();
	}
</script>

<dialog
	bind:this={dialog}
	class="anim-fade m-0 h-dvh max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-ink/35 open:flex open:items-end open:justify-center sm:open:items-center"
	onclose={close}
	oncancel={(e) => {
		e.preventDefault();
		close();
	}}
	onclick={(e) => {
		if (e.target === dialog) close();
	}}
	aria-labelledby="sheet-title"
>
	<div
		class="anim-sheet max-h-[90dvh] w-full overflow-y-auto rounded-t-[24px] bg-cream px-5 pt-3 pb-[calc(22px+env(safe-area-inset-bottom))] shadow-sheet sm:max-w-lg sm:rounded-[20px] sm:px-6 sm:pb-6"
		role="document"
	>
		<div class="mx-auto mb-3 h-1 w-9 rounded-full bg-fog sm:hidden" aria-hidden="true"></div>
		<div class="flex items-start justify-between gap-3">
			<div>
				<h2 id="sheet-title" class="text-[17px]">{title}</h2>
				{#if description}<p class="mt-1 text-[12.5px] leading-relaxed text-sage">
						{description}
					</p>{/if}
			</div>
			<button class="icon-btn -mt-1 -mr-2 flex-none" aria-label="Close" onclick={close}>×</button>
		</div>
		<div class="mt-4">
			{@render children()}
		</div>
	</div>
</dialog>
