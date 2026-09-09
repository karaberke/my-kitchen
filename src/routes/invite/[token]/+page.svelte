<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
</script>

<div class="mx-auto max-w-md">
	<div class="card p-6">
		<h1 class="text-[20px]">Join a household</h1>
		{#if !data.invite}
			<p class="mt-2 text-[13.5px] text-sage">This invitation link is not valid.</p>
		{:else if !data.invite.valid}
			<p class="mt-2 text-[13.5px] text-sage">
				This invitation to <strong>{data.invite.householdName}</strong> has expired, was revoked, or was
				already used. Ask an owner for a new link.
			</p>
		{:else}
			<p class="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
				You have been invited to <strong>{data.invite.householdName}</strong>. Members share its
				pantry and grocery lists; recipes stay personal unless shared.
			</p>
			{#if form?.message}<p class="error-text">{form.message}</p>{/if}
			{#if data.signedIn}
				<form method="post" use:enhance class="mt-4">
					<button class="btn-primary w-full">Join {data.invite.householdName}</button>
				</form>
			{:else}
				<div class="mt-4 flex flex-col gap-2">
					<a class="btn-primary w-full" href="/login?next={encodeURIComponent(data.next)}"
						>Sign in to join</a
					>
					{#if data.registrationOpen}<a
							class="btn-secondary w-full"
							href="/register?next={encodeURIComponent(data.next)}">Create an account</a
						>{/if}
				</div>
			{/if}
		{/if}
	</div>
</div>
