<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Alert from '$lib/components/Alert.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import { clearToasts, pushToast } from '$lib/client/toast.svelte';
	import { fmtDateTime, initials } from '$lib/client/format';

	let { data, form } = $props();
	let renameOpen = $state(false);
	let deleteOpen = $state(false);
	let confirmText = $state('');
	const confirmMatches = $derived(confirmText.trim() === data.managed.name);
	let inviteUrl = $state<string | null>(null);
	$effect(() => {
		if (form?.inviteUrl) inviteUrl = form.inviteUrl as string;
	});
	async function copy() {
		if (!inviteUrl) return;
		try {
			await navigator.clipboard.writeText(inviteUrl);
			pushToast('Invitation link copied.', { kind: 'success' });
		} catch {
			pushToast('Select the link and copy it manually.');
		}
	}
	const after =
		() =>
		async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			await invalidateAll();
		};
</script>

<PageHeader
	title={data.managed.name}
	subtitle="You are {data.managed.role === 'owner' ? 'an owner' : 'a member'}"
	back="/household"
>
	{#if data.isOwner}
		<button class="btn-ghost btn-sm" onclick={() => (renameOpen = true)}>Rename</button>
	{/if}
</PageHeader>

{#if form?.message}<div class="mb-3"><Alert kind="error">{form.message}</Alert></div>{/if}

<section>
	<h2 class="mb-2 text-[16px]">Members</h2>
	<ul class="card overflow-hidden">
		{#each data.members as m (m.userId)}
			<li class="divider-row flex flex-wrap items-center gap-3 px-3.5 py-3">
				<span
					class="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-leaf-soft text-[12px] font-bold text-moss"
					>{initials(m.name)}</span
				>
				<div class="min-w-0 flex-1">
					<div class="text-[13.5px] font-semibold">
						{m.name}{m.userId === data.user?.id ? ' (you)' : ''}
					</div>
					<div class="text-[11.5px] text-sage">
						{m.email} · {m.role === 'owner'
							? 'Owner · manages members'
							: 'Member · pantry and lists'}
					</div>
				</div>
				{#if data.isOwner && m.userId !== data.user?.id}
					<form method="post" action="?/role" use:enhance={after}>
						<input type="hidden" name="userId" value={m.userId} />
						<input type="hidden" name="role" value={m.role === 'owner' ? 'member' : 'owner'} />
						<button class="btn-ghost btn-sm"
							>{m.role === 'owner' ? 'Make member' : 'Make owner'}</button
						>
					</form>
					<form
						method="post"
						action="?/remove"
						use:enhance={after}
						onsubmit={(e) => {
							if (!confirm(`Remove ${m.name} from the household? They lose access immediately.`))
								e.preventDefault();
						}}
					>
						<input type="hidden" name="userId" value={m.userId} />
						<button class="btn-ghost btn-sm text-brick-dark">Remove</button>
					</form>
				{:else if m.userId === data.user?.id && !data.canLeave}
					<span class="text-[11px] text-sage">Transfer ownership before leaving</span>
				{/if}
			</li>
		{/each}
	</ul>
</section>

{#if data.isOwner}
	<section class="card-muted mt-5 p-3.5">
		<div class="eyebrow">Invitations</div>
		<p class="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
			Invitation links work once and expire after 72 hours. Whoever opens one joins as a member with
			access to this household's pantry and lists. Recipes stay personal until shared.
		</p>
		<form method="post" action="?/invite" class="mt-3" use:enhance={after}>
			<button class="btn-primary btn-sm">Create invitation link</button>
		</form>
		{#if inviteUrl}
			<div class="mt-3 rounded-[14px] border border-leaf-line bg-leaf-soft p-3">
				<div class="text-[12px] font-bold text-leaf-dark">
					Copy this link now — it is shown only once.
				</div>
				<div class="mt-1.5 flex gap-2">
					<input
						class="field h-10 flex-1 font-mono text-[12px]"
						readonly
						value={inviteUrl}
						onfocus={(e) => (e.target as HTMLInputElement).select()}
						aria-label="Invitation link"
					/>
					<button class="btn-secondary btn-sm" onclick={copy}>Copy</button>
				</div>
			</div>
		{/if}
		{#if data.invites.length}
			<ul class="mt-3 flex flex-col gap-1.5">
				{#each data.invites as inv (inv.id)}
					<li class="flex items-center gap-2 rounded-[12px] bg-card px-3 py-2 text-[12.5px]">
						<span class="flex-1"
							>Link created {fmtDateTime(inv.createdAt)}{inv.createdByName
								? ` by ${inv.createdByName}`
								: ''} · expires {fmtDateTime(inv.expiresAt)}</span
						>
						<form method="post" action="?/revoke" use:enhance={after}>
							<input type="hidden" name="inviteId" value={inv.id} /><button
								class="btn-ghost btn-sm h-8 text-brick-dark">Revoke</button
							>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

<section class="card-muted mt-5 border-brick-line p-3.5">
	<div class="eyebrow text-brick-dark">Danger zone</div>
	{#if data.isOwner}
		<p class="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
			Deleting this household erases its pantry, grocery lists and history for everyone in it.
			Recipes stay with the people who wrote them.
		</p>
		<button
			type="button"
			class="btn-danger btn-sm mt-3"
			onclick={() => {
				confirmText = '';
				deleteOpen = true;
			}}>Delete this household</button
		>
	{:else}
		<p class="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
			Leaving gives up your access to this household's pantry and grocery lists. Your own recipes
			stay with you. Only an owner can delete the household itself.
		</p>
	{/if}
	{#if data.canLeave}
		<form
			method="post"
			action="?/remove"
			class="mt-3"
			use:enhance={() => {
				clearToasts();
				return async ({ update }) => {
					await update({ reset: false });
					await invalidateAll();
				};
			}}
			onsubmit={(e) => {
				if (!confirm('Leave this household?')) e.preventDefault();
			}}
		>
			<input type="hidden" name="userId" value={data.user?.id} />
			<button class="btn-danger btn-sm">Leave this household</button>
		</form>
	{/if}
</section>

<Sheet bind:open={renameOpen} title="Rename household">
	<form
		method="post"
		action="?/rename"
		class="flex flex-col gap-3.5"
		use:enhance={() =>
			async ({ update }) => {
				await update({ reset: false });
				renameOpen = false;
				await invalidateAll();
			}}
	>
		<div>
			<label class="label" for="hh-rename">Name</label>
			<input
				class="field"
				id="hh-rename"
				name="name"
				required
				minlength="2"
				maxlength="60"
				value={data.managed.name}
			/>
		</div>
		<button class="btn-primary w-full">Save</button>
	</form>
</Sheet>

<Sheet
	bind:open={deleteOpen}
	title="Delete this household?"
	description="The pantry, grocery lists and history for “{data.managed
		.name}” will be erased. Other members lose access right away. Your recipes stay with you. This cannot be undone."
>
	<form
		method="post"
		action="?/deleteHousehold"
		class="flex flex-col gap-3.5"
		use:enhance={() => {
			clearToasts();
			return async ({ update }) => {
				await update({ reset: false });
				deleteOpen = false;
				// This household is gone: drop every cached load so the page we land on is fresh.
				await invalidateAll();
			};
		}}
	>
		<div>
			<label class="label" for="hh-delete-confirm"
				>Type <strong>{data.managed.name}</strong> to confirm</label
			>
			<input
				class="field"
				id="hh-delete-confirm"
				name="confirmName"
				autocomplete="off"
				spellcheck="false"
				bind:value={confirmText}
			/>
		</div>
		<div class="flex gap-2.5">
			<button type="button" class="btn-secondary flex-1" onclick={() => (deleteOpen = false)}
				>Cancel</button
			>
			<button class="btn-danger flex-1" disabled={!confirmMatches}>Delete household</button>
		</div>
	</form>
</Sheet>
