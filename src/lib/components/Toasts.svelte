<script lang="ts">
	import { toasts, dismissToast } from '$lib/client/toast.svelte';
</script>

<div
	class="no-print pointer-events-none fixed inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom))] z-40 flex flex-col items-center gap-2 md:right-6 md:bottom-6 md:left-auto md:w-96"
	aria-live="polite"
	aria-atomic="false"
>
	{#each toasts.items as t (t.id)}
		<div
			class="anim-toast pointer-events-auto flex w-full items-center gap-3 rounded-[16px] px-4 py-3 text-[13px] leading-snug shadow-toast {t.kind ===
			'error'
				? 'bg-brick-dark text-cream'
				: 'bg-ink text-[#f7f2e8]'}"
			role="status"
		>
			<div class="flex-1">{t.text}</div>
			{#if t.action}
				{#if t.action.href}
					<a
						href={t.action.href}
						class="flex-none font-bold text-[#e7c88b]"
						onclick={() => dismissToast(t.id)}>{t.action.label}</a
					>
				{:else}
					<button
						class="flex-none font-bold text-[#e7c88b]"
						onclick={() => {
							t.action?.onClick?.();
							dismissToast(t.id);
						}}>{t.action.label}</button
					>
				{/if}
			{/if}
			<button
				class="flex-none text-[16px] leading-none opacity-70 hover:opacity-100"
				aria-label="Dismiss"
				onclick={() => dismissToast(t.id)}>×</button
			>
		</div>
	{/each}
</div>
