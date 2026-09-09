import type { User, Session } from 'better-auth';
import type { HouseholdRole } from '$lib/server/db/schema';

declare global {
	namespace App {
		interface Locals {
			/** resolved once per request in hooks.server.ts */
			user: User | null;
			session: Session | null;
			/** memberships of the current user, loaded once per request when signed in */
			memberships: {
				householdId: string;
				name: string;
				role: HouseholdRole;
				memberCount: number;
			}[];
			/** active household (validated against memberships) */
			household: { id: string; name: string; role: HouseholdRole } | null;
			/** request id for logs */
			requestId: string;
		}
		interface Error {
			message: string;
			code?: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
