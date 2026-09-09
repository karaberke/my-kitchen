<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';

	const options = [
		{
			href: '/recipes/new',
			title: 'Enter manually',
			body: 'Type the title, servings, times, and ingredients yourself.'
		},
		{
			href: '/recipes/import',
			title: 'Import an HTML page',
			body: 'Paste a saved recipe page, or upload the file. We read the title, ingredients and steps out of it for you to check.'
		},
		{
			href: '/recipes/import?kind=pdf',
			title: 'Import a PDF',
			body: 'Cookbook exports and saved pages. Text is read page by page, then shown for review.'
		}
	];
</script>

<PageHeader title="Add a recipe" subtitle="Three ways in." back="/recipes" />

<div class="flex flex-col gap-3">
	{#each options as o (o.href)}
		<a
			href={o.href}
			class="rounded-[18px] border border-sand-dark bg-card p-4 hover:border-[#B9BE9C]"
		>
			<div class="text-[14.5px] font-bold">{o.title}</div>
			<div class="mt-1.5 text-[12.5px] leading-relaxed text-sage">{o.body}</div>
		</a>
	{/each}
</div>

<p class="px-0.5 pt-3 text-[11.5px] leading-relaxed text-sage">
	Uploaded files are kept as source attachments only. HTML is never run, PDFs are read as text, and
	the recipe is always shown in this app's own layout.
</p>
