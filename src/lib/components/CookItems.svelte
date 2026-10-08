<script lang="ts">
	import { untrack } from 'svelte';
	import IngredientAutocomplete from '$lib/components/IngredientAutocomplete.svelte';
	import { fmtQty } from '$lib/client/format';
	import { fetchFresh, remoteErrorMessage } from '$lib/client/remote';
	import { pushToast } from '$lib/client/toast.svelte';
	import { pantryLots } from '$lib/remote/pantry.remote';
	import { Dec } from '$lib/shared/decimal';
	import { NOTE_MAX_CHARS } from '$lib/shared/text';
	import type { CookPreview } from '$lib/server/cooking';

	/**
	 * The ingredient rows of the finish-cooking form: what leaves the pantry for
	 * each one. The rows are edited in place, so they are state seeded from the
	 * preview. The page keys this component on the preview, so a new preview
	 * builds new rows.
	 */
	let { preview }: { preview: CookPreview } = $props();

	interface Alloc {
		lotId: string;
		amount: string;
		revision: number;
		label: string;
	}
	interface ItemState {
		position: number;
		mode: 'deduct' | 'skip';
		ingredientId: string | null;
		ingredientName: string;
		substituteName: string;
		substituteId: string | null;
		substituteLabel: string | null;
		createIdentity: boolean;
		allocations: Alloc[];
		/** how much a substitute's lots leave uncovered, in the item's unit; null or zero when they cover it */
		shortfall: string | null;
		note: string;
		loading: boolean;
	}

	/** One lot as the cook reads it: how much, where, and by when to use it. */
	const lotLabel = (lot: {
		quantity: string;
		unit: string;
		location: string;
		expiresOn: string | null;
	}) =>
		`${fmtQty(lot.quantity, lot.unit)} · ${lot.location || 'no location'}${lot.expiresOn ? ' · use by ' + lot.expiresOn : ''}`;

	const seed = (from: CookPreview): ItemState[] =>
		from.items.map((it) => ({
			position: it.position,
			mode: it.defaultMode,
			ingredientId: it.ingredientId,
			ingredientName: it.ingredientName ?? it.name,
			substituteName: '',
			substituteId: null,
			substituteLabel: null,
			createIdentity: false,
			allocations: it.suggestions.map((s) => ({
				lotId: s.lotId,
				amount: Dec.from(s.take).toString(),
				revision: s.revision,
				label: lotLabel(s)
			})),
			shortfall: null, // the row's own `reason` already reports it for the planned ingredient
			note: '',
			loading: false
		}));
	// Read once: the page keys this component on the preview, so `preview` never changes here.
	let items = $state(untrack(() => seed(preview)));

	async function loadSubstituteLots(i: number) {
		const item = items[i];
		const id = item.substituteId;
		if (!id) return;
		item.loading = true;
		try {
			const it = preview.items[i];
			const json = await fetchFresh(
				pantryLots({
					ingredient: id,
					unit: it.unit ?? null,
					convention: preview.convention,
					amount: it.scaledAmount ?? null
				})
			);
			if (items[i].substituteId !== id) return; // stale
			items[i].allocations = json.lots.map((l) => ({
				lotId: l.lotId,
				amount: l.take ?? '',
				revision: l.revision,
				label: lotLabel(l)
			}));
			items[i].shortfall = json.shortfall;
			items[i].ingredientId = id;
			items[i].mode = json.lots.length ? 'deduct' : 'skip';
		} catch (err) {
			pushToast(remoteErrorMessage(err, 'Could not load lots'), { kind: 'error' });
		} finally {
			items[i].loading = false;
		}
	}
</script>

<ul class="flex flex-col gap-2.5">
	{#each preview.items as it, i (it.position)}
		{@const st = items[i]}
		<li class="card p-3">
			<input type="hidden" name="item.{it.position}.name" value={it.name} />
			<input type="hidden" name="item.{it.position}.mode" value={st.mode} />
			<input type="hidden" name="item.{it.position}.ingredientId" value={st.ingredientId ?? ''} />
			<div class="flex items-start justify-between gap-2">
				<div>
					<div class="text-[13.5px] font-semibold">
						{it.scaledAmount ? fmtQty(it.scaledAmount, it.unit) + ' ' : ''}{it.name}{it.optional
							? ' (optional)'
							: ''}
					</div>
					{#if it.reason}<div class="mt-0.5 text-[11.5px] text-honey-dark">
							{it.reason}
						</div>{/if}
					{#if st.shortfall && Dec.from(st.shortfall).isPositive()}<div
							class="mt-0.5 text-[11.5px] text-honey-dark"
						>
							Short by {fmtQty(st.shortfall, it.unit)} in the pantry
						</div>{/if}
					{#if it.incompatible.length}<div class="mt-0.5 text-[11.5px] text-sage">
							Also in pantry: {it.incompatible.map((x) => fmtQty(x.quantity, x.unit)).join(', ')} (not
							convertible)
						</div>{/if}
				</div>
				<div
					class="flex flex-none rounded-[10px] bg-linen p-0.5 text-[11.5px] font-bold"
					role="group"
					aria-label="Tracking for {it.name}"
				>
					<button
						type="button"
						class="rounded-[8px] px-2.5 py-1.5 {st.mode === 'deduct'
							? 'bg-card text-leaf'
							: 'text-sage'}"
						aria-pressed={st.mode === 'deduct'}
						onclick={() => (st.mode = 'deduct')}
						disabled={!st.allocations.length}>Deduct</button
					>
					<button
						type="button"
						class="rounded-[8px] px-2.5 py-1.5 {st.mode === 'skip'
							? 'bg-card text-ink'
							: 'text-sage'}"
						aria-pressed={st.mode === 'skip'}
						onclick={() => (st.mode = 'skip')}>Skip tracking</button
					>
				</div>
			</div>
			{#if st.mode === 'deduct'}
				<div class="mt-2 flex flex-col gap-1.5">
					{#each st.allocations as a, ai (a.lotId)}
						<div class="flex items-center gap-2 text-[12.5px]">
							<input type="hidden" name="item.{it.position}.alloc.{ai}.lotId" value={a.lotId} />
							<input
								type="hidden"
								name="item.{it.position}.alloc.{ai}.revision"
								value={a.revision}
							/>
							<label class="flex-1 text-sage" for="alloc-{it.position}-{ai}">Lot: {a.label}</label>
							<input
								id="alloc-{it.position}-{ai}"
								class="field h-9 w-24 py-1 text-right"
								name="item.{it.position}.alloc.{ai}.amount"
								inputmode="decimal"
								bind:value={a.amount}
								aria-label="Amount to deduct from this lot"
							/>
							<span class="w-10 text-sage"
								>{preview.items[i].suggestions.find((s) => s.lotId === a.lotId)?.unit ??
									it.unit ??
									''}</span
							>
						</div>
					{/each}
				</div>
			{/if}
			<details class="mt-2 text-[12.5px]">
				<summary class="cursor-pointer text-leaf">Substitute or note</summary>
				<div class="mt-2 grid gap-2">
					<div>
						<label class="label" for="sub-{it.position}">Used a different ingredient</label>
						<IngredientAutocomplete
							inputId="sub-{it.position}"
							fieldName="item.{it.position}.subname"
							bind:name={st.substituteName}
							bind:ingredientId={st.substituteId}
							bind:identityLabel={st.substituteLabel}
							bind:createIdentity={st.createIdentity}
							placeholder="e.g. chicken thigh"
						/>
						{#if st.substituteId && st.substituteId !== st.ingredientId}
							<button
								type="button"
								class="btn-secondary btn-sm mt-1.5"
								onclick={() => loadSubstituteLots(i)}
								disabled={st.loading}>{st.loading ? 'Loading lots…' : 'Use its pantry lots'}</button
							>
						{/if}
					</div>
					<div>
						<label class="label" for="note-{it.position}">Note</label>
						<input
							id="note-{it.position}"
							class="field"
							name="item.{it.position}.note"
							bind:value={st.note}
							placeholder="e.g. used the last of the jar"
							maxlength={NOTE_MAX_CHARS}
						/>
					</div>
				</div>
			</details>
		</li>
	{/each}
</ul>
