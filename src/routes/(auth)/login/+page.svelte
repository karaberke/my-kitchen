<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let busy = $state(false);
</script>

<div class="card p-6">
	<h1 class="text-[20px]">Welcome back</h1>
	<p class="mt-1 text-[13px] text-sage">Sign in to your recipes and household.</p>
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
				autocomplete="current-password"
				required
				minlength="8"
			/>
			<p class="hint">
				Forgot it? Password reset by email is not set up on this installation; ask a household owner
				to help.
			</p>
		</div>
		<button class="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
	</form>
</div>
{#if data.registrationOpen}
	<p class="text-center text-[13px] text-sage">
		New here? <a href="/register" class="font-bold text-leaf">Create an account</a>
	</p>
{:else}
	<p class="text-center text-[13px] text-sage">
		Registration is closed on this installation. Ask for an invitation link.
	</p>
{/if}
