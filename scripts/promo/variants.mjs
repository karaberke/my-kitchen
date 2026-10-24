#!/usr/bin/env node
/** Two intentionally different edits of the same genuine native app master. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PROMO_OUTPUT_DIR, PROMO_VIEWPORT } from './utils.mjs';

const STUDY_OUTPUT = resolve(PROMO_OUTPUT_DIR, 'apple-study');
const DIRECTIONS = [
	{
		slug: 'one-less-thing',
		title: 'One less thing',
		musicMood: 'quiet',
		targets: { plan: 4, recipe: 5, grocery: 5, ask: 16, cook: 9, success: 3 },
		intent: 'A complete chronological routine, with settled cuts and time to understand the result.'
	},
	{
		slug: 'dinner-rescued',
		title: 'Dinner rescued',
		musicMood: 'light',
		targets: { recipe: 4, grocery: 4, ask: 16, cook: 6, success: 2 },
		intent:
			'Start with the meal and obstacle; omit the weekly-plan introduction and repeated cooking detail.'
	}
];

const { values } = parseArgs({
	options: {
		master: { type: 'string' },
		edits: { type: 'string' },
		output: { type: 'string', default: STUDY_OUTPUT },
		'prepare-only': { type: 'boolean', default: false }
	}
});
assert(values.master, 'Supply --master with the new native CDP recording timeline');
const masterPath = resolve(values.master);
const master = JSON.parse(await readFile(masterPath, 'utf8'));
assert.equal(master.status, 'complete', 'Do not edit an incomplete capture');
assert.equal(master.frameRate, 60, 'These variants require the new native 60 fps master');
assert.equal(master.sourceContent?.width, PROMO_VIEWPORT.width * 2);
assert.equal(master.sourceContent?.height, PROMO_VIEWPORT.height * 2);
const edits = values.edits ? JSON.parse(await readFile(resolve(values.edits), 'utf8')) : {};
const output = resolve(values.output);
const outputRelation = relative(STUDY_OUTPUT, output);
assert(
	!outputRelation.startsWith('..') && !isAbsolute(outputRelation),
	'Keep this study in apple-study'
);
const masterRawPath = resolve(dirname(masterPath), master.rawPath);
const manifest = [];

for (const direction of DIRECTIONS) {
	const adjustment = edits[direction.slug] ?? {};
	const targets = adjustment.targets ?? direction.targets;
	const duration = Object.values(targets).reduce((sum, target) => sum + target, 0);
	const segments = Object.entries(targets).map(([name, targetDuration]) => {
		const source = master.segments.find((segment) => segment.name === name);
		assert(source, `Native master has no ${name} segment`);
		return {
			...source,
			holds: [],
			holdAtEnd: 0,
			transitionOutSeconds: 0,
			maxSpeed: 1,
			...(adjustment.segments?.[name] ?? {}),
			targetDuration
		};
	});
	const soundAccents = master.events
		.filter((event) =>
			/Open today|Save butter|Send the question|Confirm the pantry/i.test(event.label)
		)
		.map((event) => event.label);
	const timeline = {
		...master,
		title: direction.title,
		variant: direction.slug,
		musicMood: direction.musicMood,
		rawPath: masterRawPath,
		segments,
		cuts: [...(master.cuts ?? []), ...(adjustment.cuts ?? [])],
		soundAccents,
		editorialNotes: {
			intent: direction.intent,
			...(adjustment.editorialNotes ?? {}),
			masterTimeline: masterPath,
			minimumAnswerReadingSeconds: 8,
			transitions:
				'Clean cuts at settled states; preserve real interface motion within each action.'
		}
	};
	const variantOutput = resolve(output, direction.slug);
	await mkdir(variantOutput, { recursive: true });
	const timelinePath = resolve(variantOutput, 'timeline.json');
	await writeFile(timelinePath, JSON.stringify(timeline, null, 2) + '\n');
	await copyFile(
		resolve(PROMO_OUTPUT_DIR, 'photo-credit.json'),
		resolve(variantOutput, 'photo-credit.json')
	);
	const args = [
		resolve(import.meta.dirname, 'render.mjs'),
		'--timeline',
		timelinePath,
		'--output',
		variantOutput,
		'--duration',
		String(duration),
		...(values['prepare-only'] ? ['--validate-only'] : [])
	];
	const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
	assert(!result.error && result.status === 0, `${direction.title} failed validation or rendering`);
	let answerReadingSeconds = null;
	if (!values['prepare-only']) {
		const edit = JSON.parse(await readFile(resolve(variantOutput, 'edit.json'), 'utf8'));
		const readable = edit.events.find((event) => event.label === 'answerReadable');
		const cooking = edit.segments.find((segment) => segment.name === 'cook');
		assert(readable && cooking, 'The genuine answer and return to cooking must remain visible');
		answerReadingSeconds = cooking.outputStart - readable.at;
		assert(answerReadingSeconds >= 8, 'Preserve at least eight seconds for the actual response');
	}
	manifest.push({
		title: direction.title,
		intent: direction.intent,
		duration,
		answerReadingSeconds,
		timeline: timelinePath,
		metadata: resolve(variantOutput, 'export.json'),
		video: resolve(variantOutput, 'my-kitchen-promo.mp4'),
		silent: resolve(variantOutput, 'my-kitchen-clean.mp4'),
		poster: resolve(variantOutput, 'poster.png'),
		contactSheet: resolve(variantOutput, 'contact-sheet.jpg')
	});
}

await writeFile(resolve(output, 'variants.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
	values['prepare-only'] ? 'Both edit plans validated.' : 'Both genuine app edits exported.'
);
