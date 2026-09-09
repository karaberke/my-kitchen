<script lang="ts">
	import { enhance } from '$app/forms';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import RecipeForm from '$lib/components/RecipeForm.svelte';

	let { data, form } = $props();

	let fileName = $state('');
	let pasted = $state('');
	let busy = $state(false);

	const isPdf = $derived(data.kind === 'pdf');
	const ready = $derived(!!fileName || !!pasted.trim());
	const parsed = $derived(form?.parsed ? form : null);
	const saveAction = $derived(
		parsed?.attachmentId ? `?/save&attachment=${parsed.attachmentId}` : '?/save'
	);
</script>

{#if parsed}
	<PageHeader title="Check the import" subtitle="Nothing is saved yet." back="/recipes/add" />
	<div class="mb-3 flex flex-col gap-2">
		{#if parsed.source === 'json-ld'}
			<Alert kind="success">
				Found recipe data in the page. Original wording is kept — check the fields below, then save.
			</Alert>
		{:else if parsed.source === 'pdf'}
			<Alert kind="warn">
				Text came from the PDF page layout, so amounts and line breaks can read oddly. Original
				wording is kept in each ingredient — check the fields below, then save.
			</Alert>
		{:else if parsed.source === 'pdf-empty'}
			<Alert kind="warn">
				No readable text in that PDF — it is most likely scanned pages. The file is still attached,
				so you can open it while you type the recipe in below.
			</Alert>
		{:else}
			<Alert kind="warn">
				No structured recipe data in that page, so the readable text is in Notes for you to shape.
				Add the ingredients and steps you want tracked.
			</Alert>
		{/if}
		{#if parsed.attachmentId}
			<p class="px-0.5 text-[11.5px] text-sage">
				Source kept: <a
					href="/media/attachment/{parsed.attachmentId}"
					target="_blank"
					rel="noopener">{parsed.filename}</a
				>{parsed.pageCount ? ` · ${parsed.pageCount} pages` : ''} — it stays with the recipe once you
				save.
			</p>
		{/if}
	</div>
	{#key parsed.input}
		<RecipeForm
			mode="new"
			action={saveAction}
			initial={form?.input ?? parsed.input}
			errors={form?.errors ?? {}}
			message={form?.message ?? ''}
		/>
	{/key}
{:else}
	<PageHeader
		title={isPdf ? 'Import a PDF' : 'Import a recipe'}
		subtitle={isPdf ? 'From a cookbook export or saved page.' : 'From a saved HTML page.'}
		back="/recipes/add"
	/>

	{#if form?.message}<div class="mb-3"><Alert kind="error">{form.message}</Alert></div>{/if}

	<form
		method="post"
		action="?/parse"
		enctype="multipart/form-data"
		class="flex flex-col gap-4"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update({ reset: false });
				busy = false;
			};
		}}
	>
		<div>
			<label class="label" for="import-title">Title</label>
			<input
				class="field"
				id="import-title"
				name="title"
				maxlength="200"
				placeholder="Leave blank to use the title from the file"
			/>
			<p class="mt-1.5 text-[11.5px] text-sage">
				You can change this on the next screen either way.
			</p>
		</div>

		<div>
			<label class="label" for="import-file">{isPdf ? 'PDF file' : 'HTML or PDF file'}</label>
			<input
				class="field h-auto py-2.5 text-[12.5px]"
				id="import-file"
				name="file"
				type="file"
				accept={isPdf ? '.pdf,application/pdf' : '.html,.htm,.pdf,text/html,application/pdf'}
				onchange={(e) => (fileName = (e.currentTarget as HTMLInputElement).files?.[0]?.name ?? '')}
			/>
			{#if isPdf}
				<p class="mt-1.5 text-[11.5px] leading-relaxed text-sage">
					Text is read page by page. Scanned pages have no text to read — the file is still kept so
					you can copy from it by hand.
				</p>
			{/if}
		</div>

		{#if !isPdf}
			<div>
				<label class="label" for="import-html">Or paste the page source</label>
				<textarea
					class="field min-h-44 py-2.5 font-mono text-[12px]"
					id="import-html"
					name="html"
					placeholder="&lt;!DOCTYPE html&gt; …"
					bind:value={pasted}></textarea>
			</div>
		{/if}

		<p class="px-0.5 text-[11.5px] leading-relaxed text-sage">
			A file wins if you pick one. Up to 10 MB. Files are kept as the recipe's source: HTML is never
			run or shown as a page, and the recipe always appears in this app's own layout.
		</p>

		<button class="btn-primary w-full" disabled={!ready || busy}>
			{busy ? 'Reading…' : 'Read the recipe'}
		</button>
	</form>
{/if}
