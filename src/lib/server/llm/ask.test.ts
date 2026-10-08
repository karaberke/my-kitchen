import { describe, expect, it } from 'vitest';
import {
	LLM_CHAT_ANSWER_MAX_CHARS,
	LLM_CHAT_HISTORY_MAX_CHARS,
	LLM_CHAT_MAX_TURNS,
	LLM_QUESTION_MAX_CHARS
} from '$lib/shared/assistant-limits';
import type { RecipeChatTurn } from '$lib/shared/recipe-input';
import { buildRecipeChatMessages, stepNote, trimChatHistory } from './ask';

const turn = (n: number, q = `question ${n}`, a = `answer ${n}`): RecipeChatTurn => ({
	question: q,
	answer: a
});
const turns = (count: number) => Array.from({ length: count }, (_, i) => turn(i + 1));

describe('trimChatHistory', () => {
	it('keeps a short history as it is', () => {
		expect(trimChatHistory(turns(2))).toEqual(turns(2));
		expect(trimChatHistory([])).toEqual([]);
	});

	it('keeps only the newest turns when there are more than the turn limit', () => {
		const out = trimChatHistory(turns(LLM_CHAT_MAX_TURNS + 3));
		expect(out).toHaveLength(LLM_CHAT_MAX_TURNS);
		expect(out[0].question).toBe('question 4');
		expect(out.at(-1)?.question).toBe(`question ${LLM_CHAT_MAX_TURNS + 3}`);
	});

	it('drops the oldest turns first until the text fits the character limit', () => {
		const long = 'a'.repeat(LLM_CHAT_ANSWER_MAX_CHARS);
		// Four turns of 2000 + 10 characters: only two fit in the limit.
		const history = [1, 2, 3, 4].map((n) => turn(n, `q${n}`.padEnd(10, '?'), long));
		const out = trimChatHistory(history);
		const size = out.reduce((n, t) => n + t.question.length + t.answer.length, 0);
		expect(size).toBeLessThanOrEqual(LLM_CHAT_HISTORY_MAX_CHARS);
		expect(out.map((t) => t.question)).toEqual(['q3????????', 'q4????????']);
	});

	it('cuts a long question and a long answer to their limits', () => {
		const [out] = trimChatHistory([
			turn(1, 'q'.repeat(LLM_QUESTION_MAX_CHARS + 50), 'a'.repeat(LLM_CHAT_ANSWER_MAX_CHARS + 50))
		]);
		expect(out.question).toHaveLength(LLM_QUESTION_MAX_CHARS);
		expect(out.answer).toHaveLength(LLM_CHAT_ANSWER_MAX_CHARS);
	});

	it('drops a turn with an empty question or answer, also after cleaning', () => {
		const out = trimChatHistory([
			turn(1, '', 'answer'),
			turn(2, 'question', '  \n '),
			turn(3, '\u0000\u0007', 'answer'),
			turn(4)
		]);
		expect(out).toEqual([turn(4)]);
	});

	it('removes control characters from every part and does not change its input', () => {
		const history = [turn(1, 'how\u0000 much\nflour?', 'Two\tcups.\u0007')];
		const copy = structuredClone(history);
		expect(trimChatHistory(history)).toEqual([turn(1, 'how much flour?', 'Two cups.')]);
		expect(history).toEqual(copy);
	});
});

describe('stepNote', () => {
	it('names the step when it is in range', () => {
		expect(stepNote(3, 7)).toBe('(On step 3 of 7.) ');
		expect(stepNote(1, 1)).toBe('(On step 1 of 1.) ');
		expect(stepNote(7, 7)).toBe('(On step 7 of 7.) ');
	});

	it('is empty when the step is missing, out of range or not a whole number', () => {
		expect(stepNote(undefined, 7)).toBe('');
		expect(stepNote(0, 7)).toBe('');
		expect(stepNote(-2, 7)).toBe('');
		expect(stepNote(8, 7)).toBe('');
		expect(stepNote(1.5, 7)).toBe('');
		expect(stepNote(Number.NaN, 7)).toBe('');
		expect(stepNote(1, 0)).toBe('');
	});
});

describe('buildRecipeChatMessages', () => {
	const TEXT = 'DAL\n\n  - 200 g lentils';

	it('is the old single message when there is no history and no step', () => {
		expect(buildRecipeChatMessages(TEXT, [], 'How long?')).toEqual([
			{ role: 'user', content: `Recipe:\n${TEXT}\n\nQuestion: How long?` }
		]);
	});

	it('puts the recipe in the first user message and then alternates user and assistant turns', () => {
		const out = buildRecipeChatMessages(TEXT, turns(2), 'Q3');
		expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
		expect(out[0].content).toBe(`Recipe:\n${TEXT}\n\nQuestion: question 1`);
		expect(out[1].content).toBe('answer 1');
		expect(out[2].content).toBe('Question: question 2');
		expect(out[3].content).toBe('answer 2');
		expect(out[4].content).toBe('Question: Q3');
		expect(out.filter((m) => m.content.includes(TEXT))).toHaveLength(1);
	});

	it('puts the step note only before the question in the last user message', () => {
		const note = stepNote(3, 7);
		const out = buildRecipeChatMessages(TEXT, turns(2), 'Q3', note);
		expect(out.at(-1)).toEqual({ role: 'user', content: `${note}Question: Q3` });
		for (const m of out.slice(0, -1)) expect(m.content).not.toContain('On step');
	});

	it('puts the note in the single message after the recipe text when there is no history', () => {
		const out = buildRecipeChatMessages(TEXT, [], 'Q1', '(On step 2 of 4.) ');
		expect(out).toEqual([
			{ role: 'user', content: `Recipe:\n${TEXT}\n\n(On step 2 of 4.) Question: Q1` }
		]);
	});

	it('keeps the earlier messages the same bytes on the next turn, whatever the step', () => {
		const turnOne = buildRecipeChatMessages(TEXT, [], 'Q1');
		const turnTwo = buildRecipeChatMessages(TEXT, [turn(1, 'Q1', 'A1')], 'Q2', stepNote(2, 5));
		const turnThree = buildRecipeChatMessages(
			TEXT,
			[turn(1, 'Q1', 'A1'), turn(2, 'Q2', 'A2')],
			'Q3',
			stepNote(5, 5)
		);
		expect(turnTwo.slice(0, turnOne.length)).toEqual(turnOne);
		// The question of turn two is stored without its note, so turn three repeats turn two's prefix.
		expect(turnThree.slice(0, 2)).toEqual(turnTwo.slice(0, 2));
		expect(turnThree[2].content).toBe('Question: Q2');
	});
});
