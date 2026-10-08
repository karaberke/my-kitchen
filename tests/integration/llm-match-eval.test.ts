import { beforeEach, describe, expect, it } from 'vitest';
import { catalogIngredientId, createUser, requestAs, resetDb } from './helpers';
import { llmEnabled } from '$lib/server/llm/client';
import { suggestIngredientMatch } from '$lib/server/llm/match';
import { resetRateLimits } from '$lib/server/ratelimit';
import { RESOLVE_CASES } from '$lib/shared/ingredient-match-cases';
import { unstubLlm } from '../llm-stub';

/** Slow: one request per case to a real model server. */
const EVAL_TIMEOUT_MS = 600_000;

/**
 * Live evaluation of the assistant's catalog picks against the real model
 * server named by LLM_BASE_URL (and LLM_API_KEY / LLM_MODEL). Skipped unless
 * LLM_EVAL=1:
 *
 *   LLM_EVAL=1 LLM_BASE_URL=... pnpm vitest run --project integration tests/integration/llm-match-eval.test.ts
 *
 * A pick of a catalog name the case forbids, or of the wrong name, fails the
 * test. A case where the model picks nothing is only counted.
 */
describe.skipIf(process.env.LLM_EVAL !== '1')('assistant ingredient match evaluation', () => {
	beforeEach(async () => {
		await resetDb();
		resetRateLimits();
		unstubLlm();
	});

	it(
		'picks no forbidden or wrong catalog ingredient, non-matches first',
		async () => {
			expect(llmEnabled(), 'set LLM_BASE_URL to the model server to evaluate').toBe(true);
			const user = await createUser('Alice');
			const cases = [
				...RESOLVE_CASES.filter((c) => c.expected === null),
				...RESOLVE_CASES.filter((c) => c.expected !== null)
			];
			const wrongCases: string[] = [];
			let wrong = 0;
			let missed = 0;
			for (const c of cases) {
				// The 'user' allowance is per window; every case is its own request.
				resetRateLimits();
				const { picks } = await suggestIngredientMatch(requestAs(user), { names: [c.input] });
				const picked = picks[c.input] ?? null;
				if (c.expected === null) {
					for (const bad of c.notExpected ?? []) {
						if (picked && picked.id === (await catalogIngredientId(bad))) {
							wrong++;
							wrongCases.push(`"${c.input}" must not pick "${bad}"`);
						}
					}
				} else if (!picked) {
					missed++;
				} else if (picked.id !== (await catalogIngredientId(c.expected))) {
					wrong++;
					wrongCases.push(`"${c.input}" must pick "${c.expected}", picked "${picked.name}"`);
				}
			}
			console.log(`[llm-match-eval] wrong=${wrong} missed=${missed} total=${RESOLVE_CASES.length}`);
			expect(wrongCases, 'wrong picks').toEqual([]);
		},
		EVAL_TIMEOUT_MS
	);
});
