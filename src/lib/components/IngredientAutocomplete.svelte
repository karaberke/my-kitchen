<script lang="ts">
	/**
	 * Combobox for ingredient identity. The typed name is always kept as the
	 * recipe's display name; a match must be confirmed explicitly (never guessed).
	 */
	let {
		name = $bindable(''),
		ingredientId = $bindable<string | null>(null),
		identityLabel = $bindable<string | null>(null),
		createIdentity = $bindable(false),
		inputId,
		fieldName,
		placeholder = 'e.g. chicken breast',
		onenter
	}: {
		name?: string;
		ingredientId?: string | null;
		identityLabel?: string | null;
		createIdentity?: boolean;
		inputId: string;
		fieldName: string;
		placeholder?: string;
		onenter?: () => void;
	} = $props();

	interface Suggestion {
		id: string;
		name: string;
		category: string;
		scope: 'catalog' | 'mine';
		matchedAlias: string | null;
	}
	let suggestions = $state<Suggestion[]>([]);
	let open = $state(false);
	let active = $state(-1);
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;

	function search(q: string) {
		clearTimeout(timer);
		controller?.abort();
		if (q.trim().length < 2) {
			suggestions = [];
			open = false;
			return;
		}
		timer = setTimeout(async () => {
			const mine = ++seq;
			controller = new AbortController();
			try {
				const res = await fetch(`/api/ingredients?q=${encodeURIComponent(q)}`, {
					signal: controller.signal,
					headers: { accept: 'application/json' }
				});
				if (!res.ok) return;
				const data = (await res.json()) as { items: Suggestion[] };
				if (mine !== seq) return; // stale response, discard
				suggestions = data.items;
				open = true;
				active = -1;
			} catch (err) {
				if ((err as Error).name !== 'AbortError') console.warn(err);
			}
		}, 250);
	}

	function choose(s: Suggestion) {
		ingredientId = s.id;
		identityLabel = s.name;
		createIdentity = false;
		open = false;
	}
	function chooseNew() {
		ingredientId = null;
		identityLabel = null;
		createIdentity = true;
		open = false;
	}
	function clearIdentity() {
		ingredientId = null;
		identityLabel = null;
		createIdentity = false;
	}
	function onInput(e: Event) {
		name = (e.target as HTMLInputElement).value;
		if (identityLabel && identityLabel.toLowerCase() !== name.trim().toLowerCase()) {
			// keep the confirmed identity; the display name may differ from it
		}
		search(name);
	}
	function onKey(e: KeyboardEvent) {
		const total = suggestions.length + (name.trim().length >= 2 ? 1 : 0);
		if (e.key === 'ArrowDown' && total) {
			e.preventDefault();
			open = true;
			active = (active + 1) % total;
		} else if (e.key === 'ArrowUp' && total) {
			e.preventDefault();
			open = true;
			active = (active - 1 + total) % total;
		} else if (e.key === 'Escape') {
			open = false;
		} else if (e.key === 'Enter') {
			if (open && active >= 0) {
				e.preventDefault();
				active < suggestions.length ? choose(suggestions[active]) : chooseNew();
			} else if (onenter) {
				e.preventDefault();
				onenter();
			}
		}
	}
	const listId = $derived(`${inputId}-list`);
</script>

<div class="relative">
	<input
		id={inputId}
		name={fieldName}
		class="field"
		role="combobox"
		aria-expanded={open}
		aria-controls={listId}
		aria-autocomplete="list"
		aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
		autocomplete="off"
		{placeholder}
		value={name}
		oninput={onInput}
		onkeydown={onKey}
		onfocus={() => {
			if (suggestions.length) open = true;
		}}
		onblur={() => setTimeout(() => (open = false), 150)}
	/>
	{#if open}
		<ul
			id={listId}
			role="listbox"
			class="absolute top-full right-0 left-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-[14px] border border-sand bg-card py-1 shadow-lg"
		>
			{#each suggestions as s, i (s.id)}
				<li id="{listId}-{i}" role="option" aria-selected={active === i}>
					<button
						type="button"
						class="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13.5px] hover:bg-parchment {active ===
						i
							? 'bg-parchment'
							: ''}"
						onmousedown={(e) => e.preventDefault()}
						onclick={() => choose(s)}
					>
						<span class="flex-1"
							>{s.name}{#if s.matchedAlias}<span class="text-sage">
									· also “{s.matchedAlias}”</span
								>{/if}</span
						>
						<span
							class="pill {s.scope === 'mine' ? 'bg-leaf-soft text-leaf' : 'bg-linen text-sage'}"
							>{s.scope === 'mine' ? 'yours' : s.category}</span
						>
					</button>
				</li>
			{/each}
			{#if name.trim().length >= 2}
				<li
					id="{listId}-{suggestions.length}"
					role="option"
					aria-selected={active === suggestions.length}
				>
					<button
						type="button"
						class="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13.5px] text-leaf hover:bg-parchment {active ===
						suggestions.length
							? 'bg-parchment'
							: ''}"
						onmousedown={(e) => e.preventDefault()}
						onclick={chooseNew}
					>
						+ Create “{name.trim()}” as a new ingredient of mine
					</button>
				</li>
			{/if}
		</ul>
	{/if}
</div>
{#if ingredientId && identityLabel}
	<div class="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-leaf-dark">
		<span>✓ Tracked as <strong>{identityLabel}</strong></span>
		<button
			type="button"
			class="rounded px-1 text-sage hover:text-brick-dark"
			onclick={clearIdentity}
			aria-label="Remove ingredient match">✕</button
		>
	</div>
{:else if createIdentity}
	<div class="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-honey-dark">
		<span>New ingredient “{name.trim()}” will be created for you</span>
		<button
			type="button"
			class="rounded px-1 text-sage hover:text-brick-dark"
			onclick={clearIdentity}
			aria-label="Cancel new ingredient">✕</button
		>
	</div>
{:else if name.trim()}
	<div class="mt-1.5 text-[11.5px] text-sage-soft">
		Not matched to a pantry ingredient — pick one above to enable stock tracking
	</div>
{/if}
<input type="hidden" name={fieldName.replace(/name$/, 'ingredientId')} value={ingredientId ?? ''} />
<input
	type="hidden"
	name={fieldName.replace(/name$/, 'createIdentity')}
	value={createIdentity ? '1' : ''}
/>
