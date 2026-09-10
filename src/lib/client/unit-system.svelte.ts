import { browser } from '$app/environment';
import { isUnitSystem, type UnitSystem } from '$lib/shared/display-units';

const KEY = 'my-kitchen:unit-system';

function load(): UnitSystem {
	if (!browser) return 'as-written';
	try {
		const raw = localStorage.getItem(KEY);
		return raw && isUnitSystem(raw) ? raw : 'as-written';
	} catch {
		// Private mode or blocked storage: fall back to the recipe as written.
		return 'as-written';
	}
}

/**
 * The reader's preferred display system, shared by every page and remembered
 * in this browser. It is a view setting only: nothing here is ever sent to the
 * server or written to a recipe.
 */
export const unitSystem = $state<{ value: UnitSystem }>({ value: load() });

export function setUnitSystem(next: UnitSystem) {
	unitSystem.value = next;
	if (!browser) return;
	try {
		localStorage.setItem(KEY, next);
	} catch {
		// Preference simply does not persist; the session still works.
	}
}
