<script lang="ts">
	/**
	 * Sign-in buttons for whichever providers this installation has configured.
	 * Renders nothing when none are, so a password-only install is unchanged.
	 *
	 * Posts to a server action rather than calling an auth client, so it needs no
	 * extra JavaScript and still works with scripting disabled.
	 */
	let { providers = [], next = '/recipes' }: { providers?: string[]; next?: string } = $props();

	const LABELS: Record<string, string> = {
		google: 'Google',
		microsoft: 'Microsoft',
		apple: 'Apple'
	};
	const label = (id: string) =>
		LABELS[id] ?? id.replace(/(^|-)([a-z])/g, (_, s, c) => s + c.toUpperCase());
</script>

{#if providers.length}
	<div class="mt-5">
		<div class="flex items-center gap-3" role="separator">
			<span class="h-px flex-1 bg-sand-dark"></span>
			<span class="text-[11.5px] text-sage">or continue with</span>
			<span class="h-px flex-1 bg-sand-dark"></span>
		</div>
		<div class="mt-4 flex flex-col gap-2">
			{#each providers as provider (provider)}
				<form method="post" action="?/social">
					<input type="hidden" name="provider" value={provider} />
					<input type="hidden" name="next" value={next} />
					<button class="btn-secondary w-full">Continue with {label(provider)}</button>
				</form>
			{/each}
		</div>
	</div>
{/if}
