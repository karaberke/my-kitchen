/**
 * Size limits for requests to the local assistant model. Shared, so a form, a
 * remote schema and the server code that builds the prompt cut at the same length.
 */

/**
 * Text sent to the model is cut here: about 3k tokens, which leaves room in the
 * 8192-token context for the prompt and a 1500-token reply.
 */
export const LLM_MAX_INPUT_CHARS = 12_000;
/** The longest question a cook may ask the assistant about a recipe. */
export const LLM_QUESTION_MAX_CHARS = 500;
/** The most ingredient names one assistant match request asks about. */
export const INGREDIENT_MATCH_MAX_NAMES = 8;
/** Earlier question-and-answer pairs a chat sends with a new question; older ones are dropped. */
export const LLM_CHAT_MAX_TURNS = 6;
/** The longest earlier answer a chat may send back; the assistant's answers are shorter. */
export const LLM_CHAT_ANSWER_MAX_CHARS = 2000;
/**
 * All earlier turns together, in characters (about 1500 tokens). With the
 * recipe text and the answer this stays inside the model's 8192-token context.
 */
export const LLM_CHAT_HISTORY_MAX_CHARS = 6000;
