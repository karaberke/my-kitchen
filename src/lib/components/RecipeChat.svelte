<script lang="ts" module>
	/** What the chat is doing, for the page's Ask button and its wake listener. */
	export type ChatStatus = 'idle' | 'thinking' | 'speaking' | 'listening';
</script>

<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import Alert from '$lib/components/Alert.svelte';
	import { remoteErrorMessage } from '$lib/client/remote';
	import {
		listen,
		primeSpeech,
		type Dictation,
		speak,
		speechInputAvailable,
		speechLang,
		speechOutputAvailable,
		stopSpeaking
	} from '$lib/client/speech';
	import { askRecipe } from '$lib/remote/recipes.remote';
	import {
		LLM_CHAT_ANSWER_MAX_CHARS,
		LLM_CHAT_MAX_TURNS,
		LLM_QUESTION_MAX_CHARS,
		type RecipeChatTurn
	} from '$lib/shared/recipe-input';

	/**
	 * Chat with the assistant about one recipe. With `storageKey` the turns live in
	 * sessionStorage (a reload keeps them, closing the tab clears them). `voice`
	 * adds speech input and read-aloud; only the cook page may set it, because
	 * only that page may use the microphone.
	 *
	 * `ask` is a question heard by the page's wake phrase: it is sent at once and
	 * its answer (or why there is none) is read aloud, even with the sheet
	 * closed, then `onasked` lets the page clear it. `onstatus` reports what the
	 * chat is doing; anything but `idle` needs the microphone left alone.
	 * `dictate`, when given, is used by the Speak button instead of starting a
	 * second recognition next to the page's wake listener.
	 */
	let {
		recipeId,
		step,
		servings,
		storageKey,
		voice = false,
		ask = null,
		onasked,
		onstatus,
		dictate
	}: {
		recipeId: string;
		step?: number;
		servings?: string;
		storageKey?: string;
		voice?: boolean;
		ask?: string | null;
		onasked?: () => void;
		onstatus?: (status: ChatStatus) => void;
		dictate?: () => Dictation;
	} = $props();

	const READ_ALOUD_KEY = 'my-kitchen:chat-read-aloud';
	const uid = $props.id();

	let turns = $state<RecipeChatTurn[]>([]);
	let input = $state('');
	let pending = $state(false);
	let error = $state('');
	let canListen = $state(false);
	let canSpeak = $state(false);
	let listening = $state(false);
	let micError = $state('');
	let readAloud = $state(false);
	let speaking = $state(false);
	let listEl = $state<HTMLElement>();
	/** Bumped by "Clear chat" so an answer that arrives afterwards is dropped. */
	let epoch = 0;
	let recognition: Dictation | null = null;

	const status: ChatStatus = $derived(
		pending ? 'thinking' : speaking ? 'speaking' : listening && !dictate ? 'listening' : 'idle'
	);
	$effect(() => onstatus?.(status));

	$effect(() => {
		const question = ask?.trim();
		if (!question) return;
		untrack(() => {
			onasked?.();
			input = question.slice(0, LLM_QUESTION_MAX_CHARS);
			send({ speakAnswer: true });
		});
	});

	function quiet() {
		stopSpeaking();
		speaking = false;
	}

	function loadTurns(): RecipeChatTurn[] {
		if (!storageKey) return [];
		try {
			const parsed: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]');
			if (!Array.isArray(parsed)) return [];
			const out: RecipeChatTurn[] = [];
			for (const t of parsed) {
				if (
					t &&
					typeof t === 'object' &&
					typeof (t as RecipeChatTurn).question === 'string' &&
					typeof (t as RecipeChatTurn).answer === 'string'
				) {
					out.push({
						question: (t as RecipeChatTurn).question.slice(0, LLM_QUESTION_MAX_CHARS),
						answer: (t as RecipeChatTurn).answer.slice(0, LLM_CHAT_ANSWER_MAX_CHARS)
					});
				}
			}
			return out.slice(-LLM_CHAT_MAX_TURNS);
		} catch {
			return [];
		}
	}

	function saveTurns() {
		if (!storageKey) return;
		try {
			if (turns.length) sessionStorage.setItem(storageKey, JSON.stringify(turns));
			else sessionStorage.removeItem(storageKey);
		} catch {
			// storage full or blocked: the chat still works for this visit
		}
	}

	async function scrollToNewest() {
		await tick();
		if (listEl) listEl.scrollTop = listEl.scrollHeight;
	}

	onMount(() => {
		turns = loadTurns();
		// Any tap on the page lets the answers speak later on iOS, including
		// answers to "Hey Chef" questions, which come with no tap at all.
		if (voice) document.addEventListener('pointerdown', primeSpeech, { capture: true, once: true });
		if (voice) {
			canListen = speechInputAvailable();
			canSpeak = speechOutputAvailable();
			try {
				readAloud = localStorage.getItem(READ_ALOUD_KEY) === '1';
			} catch {
				readAloud = false;
			}
		}
		scrollToNewest();
		return () => {
			document.removeEventListener('pointerdown', primeSpeech, { capture: true });
			recognition?.stop();
			quiet();
		};
	});

	/** `speakAnswer` reads the answer aloud even with read-aloud off: nobody is looking. */
	async function send({ speakAnswer = false } = {}) {
		const question = input.trim();
		if (pending || !question) return;
		recognition?.stop();
		quiet();
		if (voice) primeSpeech();
		const mine = epoch;
		pending = true;
		error = '';
		scrollToNewest();
		try {
			const { answer } = await askRecipe({
				recipeId,
				question,
				history: turns.slice(-LLM_CHAT_MAX_TURNS).map((t) => ({
					question: t.question,
					answer: t.answer.slice(0, LLM_CHAT_ANSWER_MAX_CHARS)
				})),
				...(step ? { step } : {}),
				...(servings ? { servings: String(servings) } : {})
			});
			if (mine !== epoch) return;
			turns = [...turns, { question, answer }].slice(-LLM_CHAT_MAX_TURNS);
			input = '';
			saveTurns();
			if (voice && canSpeak && (readAloud || speakAnswer)) {
				speaking = true;
				speak(answer, speechLang(), () => (speaking = false));
			}
		} catch (err) {
			if (mine !== epoch) return;
			// The question stays in the box so the cook can send it again.
			error = remoteErrorMessage(err, 'Could not reach the server. Check your connection.');
			if (voice && canSpeak && speakAnswer) {
				speaking = true;
				speak(`Sorry, I could not answer. ${error}`, speechLang(), () => (speaking = false));
			}
		} finally {
			if (mine === epoch) {
				pending = false;
				scrollToNewest();
			}
		}
	}

	function clearChat() {
		epoch++;
		recognition?.stop();
		quiet();
		turns = [];
		error = '';
		micError = '';
		pending = false;
		saveTurns();
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
		e.preventDefault();
		send();
	}

	async function toggleMic() {
		if (listening) {
			recognition?.stop();
			return;
		}
		micError = '';
		quiet(); // the microphone must not hear the answer
		// Without `dictate`, tell the page first: its wake listener must let go of the microphone.
		if (!dictate) onstatus?.('listening');
		const session = dictate ? dictate() : listen({ lang: speechLang() });
		recognition = session;
		listening = true;
		try {
			const text = await session.result;
			input = (input.trim() ? input.trimEnd() + ' ' : '') + text;
			input = input.slice(0, LLM_QUESTION_MAX_CHARS);
		} catch (err) {
			micError = err instanceof Error ? err.message : 'Could not use the microphone.';
		} finally {
			if (recognition === session) recognition = null;
			listening = false;
		}
	}

	function setReadAloud(on: boolean) {
		readAloud = on;
		if (!on) quiet();
		try {
			localStorage.setItem(READ_ALOUD_KEY, on ? '1' : '0');
		} catch {
			// the choice lasts for this visit only
		}
	}
</script>

<div class="flex flex-col gap-3">
	<div
		bind:this={listEl}
		class="flex max-h-[40dvh] min-h-16 flex-col gap-2.5 overflow-y-auto pr-1"
		role="log"
		aria-label="Conversation with the assistant"
	>
		{#if !turns.length && !pending}
			<p class="text-[12.5px] text-sage">
				Ask about this recipe, for example: Can I swap the butter for oil?
			</p>
		{/if}
		{#each turns as turn, i (i)}
			<p
				class="max-w-[85%] self-end rounded-[14px] bg-linen px-3 py-2 text-[13.5px] leading-relaxed whitespace-pre-line text-ink"
			>
				<span class="sr-only">You: </span>{turn.question}
			</p>
			<p
				class="max-w-[92%] self-start rounded-[14px] border border-sand bg-card px-3 py-2 text-[13.5px] leading-relaxed whitespace-pre-line text-ink-soft"
			>
				<span class="sr-only">Assistant: </span>{turn.answer}
			</p>
		{/each}
	</div>

	<div aria-live="polite">
		{#if pending}
			<p class="text-[12.5px] text-sage">Thinking… this can take a minute.</p>
		{/if}
		{#if error}<Alert kind="error">{error}</Alert>{/if}
		{#if micError}<Alert kind="warn">{micError}</Alert>{/if}
	</div>

	<form
		class="flex flex-col gap-2"
		onsubmit={(e) => {
			e.preventDefault();
			send();
		}}
	>
		<label class="label" for="{uid}-question">Your question</label>
		<textarea
			class="field min-h-20 py-2.5"
			id="{uid}-question"
			bind:value={input}
			maxlength={LLM_QUESTION_MAX_CHARS}
			rows="2"
			enterkeyhint="send"
			onkeydown={onKeydown}
			placeholder="Ask a question. Enter sends, Shift+Enter adds a line."></textarea>
		<div class="flex flex-wrap items-center gap-2">
			<button
				type="submit"
				class="btn-primary"
				disabled={pending || !input.trim()}
				aria-busy={pending}
			>
				{pending ? 'Thinking…' : 'Send'}
			</button>
			{#if canListen}
				<button
					type="button"
					class="btn-secondary {listening ? 'border-leaf bg-leaf-soft text-leaf-dark' : ''}"
					aria-pressed={listening}
					onclick={toggleMic}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
						><rect x="9" y="3" width="6" height="11" rx="3"></rect><path
							d="M5 11a7 7 0 0 0 14 0M12 18v3"
						></path></svg
					>
					{listening ? 'Listening… tap to stop' : 'Speak'}
				</button>
			{/if}
			<button type="button" class="btn-ghost ml-auto" disabled={!turns.length} onclick={clearChat}>
				Clear chat
			</button>
		</div>
	</form>

	{#if canSpeak}
		<label class="flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] text-moss">
			<input
				type="checkbox"
				class="h-5 w-5 accent-leaf"
				checked={readAloud}
				onchange={(e) => setReadAloud(e.currentTarget.checked)}
			/>
			Read answers aloud
		</label>
	{/if}
	{#if canListen || canSpeak}
		<p class="text-[11.5px] text-sage-soft">Speech is handled by your browser.</p>
	{/if}
	<p class="text-[11.5px] text-sage-soft">Answers come from the assistant and can be wrong.</p>
</div>
