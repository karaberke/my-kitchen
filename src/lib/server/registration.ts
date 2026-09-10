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

/** Cookie carrying the invite a social sign-in was started from. */
export const INVITE_COOKIE = 'mk_invite';

/**
 * Whether a social callback may create a brand-new account.
 *
 * The OAuth round trip loses the `next=/invite/<token>` context that /register
 * relies on, so the invite page drops the token into a short-lived cookie and we
 * read it back here. Same policy, same helpers — a closed install stays closed.
 */
export async function socialSignUpAllowed(
	db: DbOrTx,
	request: Request | null,
	open: boolean = serverEnv().REGISTRATION_OPEN
): Promise<boolean> {
	if (open) return true;
	const token = inviteTokenFromCookie(request?.headers.get('cookie') ?? null);
	if (!token) return false;
	const invite = await peekInvite(db, token);
	return !!invite?.valid;
}

/** Reads the invite token from a Cookie header, without pulling in a cookie parser. */
export function inviteTokenFromCookie(header: string | null): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (name !== INVITE_COOKIE) continue;
		const value = decodeURIComponent(rest.join('='));
		return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
	}
	return null;
}
