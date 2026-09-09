<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let busy = $state(false);
</script>

<div class="card p-6">
	<h1 class="text-[20px]">Create your account</h1>
	<p class="mt-1 text-[13px] text-sage">
		You get a personal household right away. Invite others later.
	</p>
	{#if !data.registrationOpen}
		<div
			class="mt-4 rounded-[14px] border border-honey-line bg-honey-soft px-3.5 py-3 text-[13px] text-honey-dark"
		>
			Registration is closed on this installation. Ask a household owner for an invitation link; it
			lets you create an account.
		</div>
	{:else}
		<form
			method="post"
			class="mt-5 flex flex-col gap-4"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					busy = false;
					await update({ reset: false });
				};
			}}
		>
			<input type="hidden" name="next" value={data.next} />
			{#if form?.message}
				<div
					class="rounded-[14px] border border-brick-line bg-brick-soft px-3.5 py-3 text-[13px] text-brick-dark"
					role="alert"
				>
					{form.message}
				</div>
			{/if}
			<div>
				<label class="label" for="name">Your name</label>
				<input
					class="field"
					id="name"
					name="name"
					autocomplete="name"
					required
					minlength="2"
					value={form?.name ?? ''}
				/>
			</div>
			<div>
				<label class="label" for="email">Email</label>
				<input
					class="field"
					id="email"
					name="email"
					type="email"
					autocomplete="email"
					required
					value={form?.email ?? ''}
				/>
			</div>
			<div>
				<label class="label" for="password">Password</label>
				<input
					class="field"
					id="password"
					name="password"
					type="password"
					autocomplete="new-password"
					required
					minlength="8"
				/>
				<p class="hint">At least 8 characters.</p>
			</div>
			<button class="btn-primary w-full" disabled={busy}
				>{busy ? 'Creating…' : 'Create account'}</button
			>
		</form>
	{/if}
</div>
<p class="text-center text-[13px] text-sage">
	Already have an account? <a href="/login" class="font-bold text-leaf">Sign in</a>
</p>
