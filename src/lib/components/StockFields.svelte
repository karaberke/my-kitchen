<script lang="ts">
	import type { Snippet } from 'svelte';
	import { UNITS } from '$lib/shared/units';
	import { LOCATION_MAX_CHARS } from '$lib/shared/text';

	/**
	 * The fields that put stock into the pantry: how much, in which unit, where
	 * it goes and by when to use it. The add sheet, the grocery purchase sheet
	 * and the scan confirmation share them; each names its own quantity field,
	 * so the server actions read the same form keys as before.
	 *
	 * Ids are `<idPrefix>-qty`, `-unit`, `-loc` and `-exp`. `children` render
	 * as extra cells between the unit and the location, inside the same grid.
	 */
	let {
		idPrefix,
		quantity = $bindable(''),
		unit = $bindable(''),
		quantityName = 'quantity',
		quantityLabel,
		quantityPlaceholder,
		quantityRequired = false,
		unitPlaceholder,
		unitHint,
		locationLabel = 'Location',
		locationPlaceholder,
		locationList,
		expiresHint,
		children
	}: {
		idPrefix: string;
		quantity?: string;
		unit?: string;
		quantityName?: string;
		quantityLabel: string;
		quantityPlaceholder?: string;
		quantityRequired?: boolean;
		/** When set the unit must be chosen: this text is the disabled first option. */
		unitPlaceholder?: string;
		unitHint?: string;
		locationLabel?: string;
		locationPlaceholder: string;
		/** The id of a `<datalist>` that suggests locations. */
		locationList?: string;
		expiresHint?: string;
		children?: Snippet;
	} = $props();
</script>

<div class="grid grid-cols-2 gap-3">
	<div>
		<label class="label" for="{idPrefix}-qty">{quantityLabel}</label>
		<input
			class="field"
			id="{idPrefix}-qty"
			name={quantityName}
			inputmode="decimal"
			required={quantityRequired}
			placeholder={quantityPlaceholder}
			bind:value={quantity}
		/>
	</div>
	<div>
		<label class="label" for="{idPrefix}-unit">Unit</label>
		<select
			class="field"
			id="{idPrefix}-unit"
			name="unit"
			required={!!unitPlaceholder}
			bind:value={unit}
		>
			{#if unitPlaceholder}<option value="" disabled>{unitPlaceholder}</option>{/if}
			{#each UNITS as u (u.id)}<option value={u.id}
					>{u.singular}{u.plural !== u.singular ? ` / ${u.plural}` : ''}</option
				>{/each}
		</select>
		{#if unitHint}<p class="hint">{unitHint}</p>{/if}
	</div>
	{@render children?.()}
	<div>
		<label class="label" for="{idPrefix}-loc">{locationLabel}</label>
		<input
			class="field"
			id="{idPrefix}-loc"
			name="location"
			list={locationList}
			placeholder={locationPlaceholder}
			maxlength={LOCATION_MAX_CHARS}
		/>
	</div>
	<div>
		<label class="label" for="{idPrefix}-exp"
			>Use-by date <span class="font-normal text-sage">(optional)</span></label
		>
		<input class="field" id="{idPrefix}-exp" name="expiresOn" type="date" />
		{#if expiresHint}<p class="hint">{expiresHint}</p>{/if}
	</div>
</div>
