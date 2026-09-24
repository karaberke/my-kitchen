<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A native multi-select filter: `<details>` + `<fieldset>` groups of
	 * checkboxes, not an ARIA menu. Every checkbox submits the enclosing GET
	 * form on change, so filter state lives only in the URL. Rendered inside
	 * the page's search form; it holds no mutation forms of its own — pass
	 * those (e.g. a "Manage categories…" button that opens a `Sheet` outside
	 * the form) through `children`.
	 */
	let {
		groups,
		pills = [],
		clearHref,
		children
	}: {
		groups: {
			legend: string;
			name: string;
			options: { value: string; label: string; checked: boolean }[];
		}[];
		pills?: { label: string; href: string }[];
		clearHref: string;
		children?: Snippet;
	} = $props();

	let open = $state(false);
	const activeCount = $derived(
		groups.reduce((n, g) => n + g.options.filter((o) => o.checked).length, 0)
	);

	function closeOnOutside(node: HTMLElement) {
		function onPointerDown(e: PointerEvent) {
			if (open && !node.contains(e.target as Node)) open = false;
		}
		document.addEventListener('pointerdown', onPointerDown);
		return () => document.removeEventListener('pointerdown', onPointerDown);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && open) open = false;
	}}
/>

<div class="flex flex-wrap items-center gap-2">
	<div class="relative" {@attach closeOnOutside}>
		<details bind:open>
			<summary class="chip cursor-pointer list-none [&::-webkit-details-marker]:hidden">
				Filter{#if activeCount}<span> · {activeCount}</span>{/if}
			</summary>
			<div class="card absolute top-full left-0 z-20 mt-2 w-72 p-4 shadow-sheet">
				<div class="flex flex-col gap-4">
					{#each groups as group (group.name)}
						<fieldset>
							<legend class="label">{group.legend}</legend>
							<div class="flex flex-col gap-1.5">
								{#each group.options as opt (opt.value)}
									<label class="flex min-h-9 items-center gap-2.5 text-[13.5px]">
										<input
											type="checkbox"
											name={group.name}
											value={opt.value}
											checked={opt.checked}
											class="h-5 w-5 accent-leaf"
											onchange={(e) => e.currentTarget.form?.requestSubmit()}
										/>
										{opt.label}
									</label>
								{/each}
							</div>
						</fieldset>
					{/each}
					{#if children}
						<div class="border-t border-line pt-3">
							{@render children()}
						</div>
					{/if}
					<noscript
						><button type="submit" class="btn-secondary btn-sm w-full">Apply</button></noscript
					>
				</div>
			</div>
		</details>
	</div>
	{#each pills as p (p.href)}
		<a href={p.href} class="chip h-8 bg-card text-[12px]" aria-label="Remove {p.label} filter">
			{p.label} <span aria-hidden="true">×</span>
		</a>
	{/each}
	{#if activeCount || pills.length}
		<a href={clearHref} class="chip h-8 text-[12px]">Clear</a>
	{/if}
</div>
