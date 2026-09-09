import type { DbOrTx } from '$lib/server/db';
import { serverEnv } from '$lib/server/env';
import { peekInvite } from '$lib/server/households';

/** `/invite/<token>` → token, otherwise null. */
export function inviteTokenFromPath(next: string): string | null {
	const m = /^\/invite\/([A-Za-z0-9_-]{16,128})$/.exec(next);
	return m ? m[1] : null;
}

/**
 * Whether a new account may be created right now. Sign-ups are open globally
 * (REGISTRATION_OPEN) or for someone holding a valid household invitation link,
 * so a private install can stay closed and still grow by invitation.
 */
export async function registrationAllowed(
	db: DbOrTx,
	next: string,
	open: boolean = serverEnv().REGISTRATION_OPEN
): Promise<boolean> {
	if (open) return true;
	const token = inviteTokenFromPath(next);
	if (!token) return false;
	const invite = await peekInvite(db, token);
	return !!invite?.valid;
}
