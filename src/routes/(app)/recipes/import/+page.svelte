<script lang="ts">
	import { enhance } from '$app/forms';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import RecipeForm from '$lib/components/RecipeForm.svelte';
	import type { RecipeFormInput } from '$lib/shared/recipe-input';

	let { data, form } = $props();

	let fileName = $state('');
	let pasted = $state('');
	let busy = $state(false);

	const isPdf = $derived(data.kind === 'pdf');
	const ready = $derived(!!fileName || !!pasted.trim());

	/**
	 * What the parse found, remembered on the client. A save that fails comes
	 * back with errors but no parse result, so holding it here is what keeps the
	 * review screen — and the user's edits — on screen instead of resetting.
	 */
	let review = $state<{
		source: string;
		attachmentId: string;
		filename: string;
		pageCount: number | null;
		input: RecipeFormInput;
	} | null>(null);
	$effect(() => {
		if (form && 'parsed' in form && form.parsed)
			review = {
				source: String(form.source ?? 'text'),
				attachmentId: String(form.attachmentId ?? ''),
				filename: String(form.filename ?? 'source file'),
				pageCount: (form.pageCount as number | null) ?? null,
				input: form.input as RecipeFormInput
			};
	});
	const saveAction = $derived(
		review?.attachmentId ? `?/save&attachment=${review.attachmentId}` : '?/save'
	);
	const submitted = $derived(
		form && 'input' in form ? (form.input as RecipeFormInput | undefined) : undefined
	);
</script>

{#if review}
	<PageHeader title="Check the import" subtitle="Nothing is saved yet." back="/recipes/add" />
	<div class="mb-3 flex flex-col gap-2">
		{#if review.source === 'json-ld'}
			<Alert kind="success">
				Found recipe data in the page. Original wording is kept — check the fields below, then save.
			</Alert>
		{:else if review.source === 'pdf'}
			<Alert kind="warn">
				Text came from the PDF page layout, so amounts and line breaks can read oddly. Original
				wording is kept in each ingredient — check the fields below, then save.
			</Alert>
		{:else if review.source === 'pdf-empty'}
			<Alert kind="warn">
				No readable text in that PDF — it is most likely scanned pages. The file is still attached,
				so you can open it while you type the recipe in below.
			</Alert>
		{:else}
			<Alert kind="warn">
				That page carries no structured recipe data, so there was nothing reliable to read out of
				it. Open the original alongside this form and copy across what you want tracked.
			</Alert>
		{/if}
		{#if review.attachmentId}
			{@const unstructured = review.source === 'text' || review.source === 'pdf-empty'}
			{#if unstructured}
				<a
					class="btn-secondary btn-sm self-start"
					href="/media/attachment/{review.attachmentId}"
					target="_blank"
					rel="noopener">Open {review.filename} in a new tab ↗</a
				>
			{/if}
			<p class="px-0.5 text-[11.5px] text-sage">
				Source kept: <a
					href="/media/attachment/{review.attachmentId}"
					target="_blank"
					rel="noopener">{review.filename}</a
				>{review.pageCount ? ` · ${review.pageCount} pages` : ''} — it stays with the recipe once you
				save.
			</p>
		{/if}
	</div>
	{#key submitted ?? review.input}
		<RecipeForm
			mode="new"
			action={saveAction}
			initial={submitted ?? review.input}
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
