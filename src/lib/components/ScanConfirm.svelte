<script lang="ts">
	import Sheet from '$lib/components/Sheet.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import ScanForm from '$lib/components/ScanForm.svelte';
	import type { ActionResult } from '@sveltejs/kit';
	import type { BarcodeLookup } from '$lib/server/barcode/lookup';
	import type { ScanSuggestion } from '$lib/server/barcode/suggest';

	/**
	 * Confirm a scanned product before anything is stored.
	 *
	 * Every value is editable, and nothing reaches the pantry until Add is
	 * pressed. Where a value came from is shown beside it, so a household's own
	 * correction is never confused with what a provider said.
	 */
	export interface Scan {
		code: string;
		symbology: string | null;
		lookup: BarcodeLookup;
		suggestion: ScanSuggestion;
	}

	let {
		scan,
		categories,
		aiEnabled = false,
		operationId,
		form = null,
		onclose,
		onresult
	}: {
		scan: Scan | null;
		categories: readonly string[];
		/** show "Ask the assistant" beside the candidates */
		aiEnabled?: boolean;
		operationId: string;
		/** The last action result for this sheet, so a server rejection shows in place. */
		form?: { message?: string } | null;
		onclose: () => void;
		onresult: (result: ActionResult) => void;
	} = $props();
</script>

<Sheet
	open={!!scan}
	{onclose}
	title={scan?.lookup.outcome === 'known' ? 'Add this again' : 'Confirm this product'}
	description="Nothing is stored until you press Add to pantry."
>
	{#if scan}
		{#if form?.message}
			<Alert class="mb-3" kind="error">{form.message}</Alert>
		{/if}
		<!-- A different barcode builds a new form, so no value of the last one is kept. -->
		{#key scan.lookup.gtin + scan.suggestion.from}
			<ScanForm {scan} {categories} {aiEnabled} {operationId} {onresult} />
		{/key}
	{/if}
</Sheet>
