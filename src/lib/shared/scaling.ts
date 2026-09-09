import { Dec } from './decimal';

function assertPositive(v: Dec, name: string) {
	if (!v.isPositive()) throw new RangeError(`${name} must be positive`);
}

/** Scale a base amount from base servings to target servings. Unknown stays unknown. */
export function scaleAmount(base: Dec | null, baseServings: Dec, targetServings: Dec): Dec | null {
	assertPositive(baseServings, 'baseServings');
	assertPositive(targetServings, 'targetServings');
	if (base === null) return null;
	return base.mulDiv(targetServings, baseServings);
}

export function scaleFactor(baseServings: Dec, targetServings: Dec): string {
	return targetServings.div(baseServings).toHuman();
}
