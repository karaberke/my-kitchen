<script lang="ts" module>
	/**
	 * How often to ask for the job list while one is running. Shorter than the
	 * household poll (20 s): the query reads server memory, runs only while a job
	 * does, and the person is waiting for the draft.
	 */
	export const ASSISTANT_POLL_MS = 5000;
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { pushToast } from '$lib/client/toast.svelte';
	import { fetchFresh, remoteErrorMessage } from '$lib/client/remote';
	import { assistantJobs, dismissAssistantJob } from '$lib/remote/recipes.remote';

	type Jobs = Awaited<ReturnType<typeof dismissAssistantJob>>['jobs'];

	/** The jobs the layout load had at render time; later answers replace them. */
	let { initial }: { initial: Jobs } = $props();

	let jobs = $derived<Jobs>(initial);
	let dismissing = $state<string | null>(null);
	const running = $derived(jobs.some((j) => j.status === 'running'));

	/** Status of each job as last seen, to tell "just finished" from "was already done". */
	let seen: Record<string, string> = {};
	function adopt(next: Jobs) {
		for (const job of next) {
			if (job.status === 'done' && seen[job.id] === 'running') {
				pushToast(`Draft ready: ${job.title}`, {
					kind: 'success',
					timeout: 10000,
					action: job.recipeId ? { label: 'Open', href: `/recipes/${job.recipeId}` } : undefined
				});
			}
		}
		seen = Object.fromEntries(next.map((job) => [job.id, job.status]));
		jobs = next;
	}
	// A new layout load (for example after an import starts) hands over fresh data.
	$effect(() => adopt(initial));

	let failures = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped by each check and on cleanup, so an answer that arrives late is dropped. */
	let latest = 0;

	async function check() {
		clearTimeout(timer);
		if (!running) return;
		if (document.hidden || !navigator.onLine) return schedule();
		const mine = ++latest;
		try {
			const answer = await fetchFresh(assistantJobs());
			if (mine !== latest) return;
			failures = 0;
			adopt(answer.jobs);
		} catch {
			if (mine !== latest) return;
			failures++;
		}
		schedule();
	}
	function schedule() {
		clearTimeout(timer);
		if (!running) return;
		timer = setTimeout(check, ASSISTANT_POLL_MS * (1 + Math.min(5, failures)));
	}
	// Polls only while a job runs; the timer stops as soon as none does.
	$effect(() => {
		if (running) schedule();
		return () => {
			clearTimeout(timer);
			latest++;
		};
	});
	function onVisible() {
		if (!document.hidden && running) check();
	}
	onMount(() => () => {
		clearTimeout(timer);
		latest++;
	});

	async function dismiss(id: string) {
		dismissing = id;
		try {
			adopt((await dismissAssistantJob({ id })).jobs);
		} catch (err) {
			pushToast(remoteErrorMessage(err, 'Could not dismiss this. Try again.'), { kind: 'error' });
		} finally {
			dismissing = null;
		}
	}
</script>

<svelte:document onvisibilitychange={onVisible} />
<svelte:window ononline={onVisible} onfocus={onVisible} />

{#if jobs.length}
	<!-- Top of the screen: the bottom is taken by the tab bar, the sticky save bar and the toasts. -->
	<div
		class="no-print pointer-events-none fixed inset-x-3 top-14 z-40 flex flex-col gap-2 md:top-4 md:right-6 md:left-auto md:w-96"
	>
		{#each jobs as job (job.id)}
			<div
				class="anim-toast pointer-events-auto flex items-start gap-3 rounded-[16px] border px-3.5 py-2.5 text-[13px] leading-snug shadow-toast {job.status ===
				'failed'
					? 'border-brick-line bg-brick-soft text-brick-dark'
					: job.status === 'done'
						? 'border-leaf-line bg-leaf-soft text-leaf-dark'
						: 'border-sand bg-card text-ink-soft'}"
				role="status"
				aria-live="polite"
			>
				{#if job.status === 'running'}
					<span
						class="mt-0.5 h-4 w-4 flex-none animate-spin rounded-full border-2 border-leaf-line border-t-leaf motion-reduce:animate-none"
						aria-hidden="true"
					></span>
					<div class="min-w-0 flex-1">
						Assistant is reading “<span class="font-semibold break-words">{job.title}</span>”…
					</div>
				{:else}
					<div class="min-w-0 flex-1">
						{#if job.status === 'done'}
							<div class="font-semibold break-words">
								Draft ready:
								{#if job.recipeId}
									<a class="underline underline-offset-2" href="/recipes/{job.recipeId}"
										>{job.title}</a
									>
								{:else}
									{job.title}
								{/if}
							</div>
						{:else}
							<div class="font-semibold break-words">Could not read “{job.title}”</div>
						{/if}
						{#if job.message}<div class="mt-0.5 text-[12px] break-words">{job.message}</div>{/if}
					</div>
					<button
						type="button"
						class="-my-1 -mr-1.5 flex h-9 w-9 flex-none items-center justify-center rounded-[11px] text-[18px] leading-none opacity-70 hover:opacity-100 disabled:opacity-40"
						aria-label="Dismiss: {job.title}"
						disabled={dismissing === job.id}
						onclick={() => dismiss(job.id)}>×</button
					>
				{/if}
			</div>
		{/each}
	</div>
{/if}
