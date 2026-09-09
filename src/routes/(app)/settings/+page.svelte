<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import { clearToasts, pushToast } from '$lib/client/toast.svelte';
	let { data, form } = $props();
	const msg = (f: string) => (form?.form === f ? form : null);
	const report = $derived(form?.form === 'consistency' && 'report' in form ? form.report : null);
</script>

<PageHeader title="Settings" subtitle="Signed in as {data.user?.name}" />

<div class="grid gap-4 md:grid-cols-2">
	<section class="card p-4">
		<h2 class="text-[16px]">Your name</h2>
		{#if msg('name')?.message}<div class="mt-2">
				<Alert kind="error">{msg('name')?.message}</Alert>
			</div>{/if}
		<form
			method="post"
			action="?/name"
			class="mt-3 flex gap-2"
			use:enhance={() =>
				async ({ result, update }) => {
					await update({ reset: false });
					if (result.type === 'success') {
						pushToast('Name updated.', { kind: 'success' });
						await invalidateAll();
					}
				}}
		>
			<input
				class="field flex-1"
				name="name"
				value={data.user?.name ?? ''}
				minlength="2"
				maxlength="80"
				aria-label="Name"
				required
			/>
			<button class="btn-primary">Save</button>
		</form>
		<p class="hint">
			Email: {data.user?.email}. Email changes and password reset by email are not available without
			an email transport.
		</p>
	</section>

	<section class="card p-4">
		<h2 class="text-[16px]">Password</h2>
		{#if msg('password')?.message}<div class="mt-2">
				<Alert kind="error">{msg('password')?.message}</Alert>
			</div>{/if}
		<form
			method="post"
			action="?/password"
			class="mt-3 flex flex-col gap-3"
			use:enhance={() =>
				async ({ result, update }) => {
					await update();
					if (result.type === 'success')
						pushToast('Password updated. Other sessions were signed out.', { kind: 'success' });
				}}
		>
			<div>
				<label class="label" for="cur">Current password</label><input
					class="field"
					id="cur"
					name="currentPassword"
					type="password"
					autocomplete="current-password"
					required
				/>
			</div>
			<div>
				<label class="label" for="new">New password</label><input
					class="field"
					id="new"
					name="newPassword"
					type="password"
					autocomplete="new-password"
					minlength="8"
					required
				/>
			</div>
			<div>
				<label class="label" for="conf">Repeat new password</label><input
					class="field"
					id="conf"
					name="confirm"
					type="password"
					autocomplete="new-password"
					minlength="8"
					required
				/>
			</div>
			<button class="btn-primary">Update password</button>
		</form>
	</section>

	<section class="card p-4">
		<h2 class="text-[16px]">Units for new recipes</h2>
		<p class="mt-1 text-[12.5px] text-sage">
			Default measuring convention for cups and spoons. Each recipe stores its own; entered units
			are always preserved. Volume is never converted to weight without an ingredient density.
		</p>
		<form
			method="post"
			action="?/convention"
			class="mt-3 flex gap-2"
			use:enhance={() =>
				async ({ result, update }) => {
					await update({ reset: false });
					if (result.type === 'success') pushToast('Saved.', { kind: 'success' });
				}}
		>
			<select
				class="field flex-1"
				name="convention"
				value={data.convention}
				aria-label="Convention"
			>
				<option value="metric">Metric · 250 ml cup, 15 ml tbsp</option>
				<option value="us">US customary · 236.6 ml cup, 14.8 ml tbsp</option>
			</select>
			<button class="btn-primary">Save</button>
		</form>
	</section>

	<section class="card p-4">
		<h2 class="text-[16px]">Data</h2>
		<div class="mt-3 flex flex-wrap gap-2">
			<a class="btn-secondary btn-sm" href="/recipes/export.json" download="recipes.json"
				>Export my recipes (JSON)</a
			>
			<a
				class="btn-secondary btn-sm"
				href="/recipes/export.json?scope=all"
				download="recipes-all.json">Export incl. shared with me</a
			>
		</div>
		<p class="hint">
			Versioned JSON with units and ordering metadata. Importing is not part of this release.
		</p>
		<form method="post" action="?/consistency" class="mt-3" use:enhance>
			<button class="btn-ghost btn-sm">Run pantry consistency check</button>
		</form>
		{#if report}
			<div class="mt-2">
				<Alert
					kind={report.lotMismatches.length || report.lineMismatches.length ? 'warn' : 'success'}
					>Checked {report.lotsChecked} lots: {report.lotMismatches.length} balance mismatches, {report
						.lineMismatches.length} purchase credit mismatches.</Alert
				>
			</div>
		{/if}
	</section>

	<section class="card p-4 md:col-span-2">
		<h2 class="text-[16px]">This installation</h2>
		<ul class="mt-2 text-[13px] text-ink-soft">
			<li>Registration: {data.registrationOpen ? 'open' : 'closed (invite only)'}</li>
			<li>Image storage: {data.storageBackend}</li>
			<li>
				Household sync: polls every {Math.round(data.pollMs / 1000)} s while a pantry or list screen is
				visible
			</li>
		</ul>
		<form
			method="post"
			action="?/signOut"
			class="mt-4"
			use:enhance={() => {
				clearToasts();
				return async ({ update }) => update();
			}}
		>
			<button class="btn-dark">Sign out</button>
		</form>
	</section>
</div>
