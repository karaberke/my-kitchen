# Perception and attention evidence for a real-app portrait demo

## How can scrolling and cuts feel continuous?

### Takeaway

Keep attention on one meaningful action and let the next view answer the expectation created by that action. Smoothness depends on continuity of attention, not merely softening every cut. [Smith, 2012](https://eprints.bbk.ac.uk/6679/1/6679.pdf)

### Cited Findings

- **Tim J. Smith, “The Attentional Theory of Cinematic Continuity,” Projections 6(1), 2012, pp. 1–27.** This theoretical synthesis uses film examples and eye-movement evidence. In its match-action discussion, movement directs attention toward an anticipated location; matching the action and screen location across a cut can meet that expectation. Its comparison with a whip pan shows why whole-frame movement can make viewers search again. This is a film-perception account, not an experiment on app ads. [Author manuscript, Birkbeck University](https://eprints.bbk.ac.uk/6679/1/6679.pdf)
- **Zacks, Speer, Swallow, and Maley, “The Brain’s Cutting-Room Floor: Segmentation of Narrative Cinema,” Frontiers in Human Neuroscience 4:168, 2010.** Viewers watched a narrative film; researchers examined behavioral event boundaries and brain activity. Changes in the depicted situation predicted segmentation. After controlling for situation changes, cuts themselves did not increase segmentation. The study does not establish an ideal cut frequency or advertising duration. [Primary paper](https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2010.00168/full)

### Inferences

- **Editing decision:** Preserve the fixed phone viewport. Use one deliberate swipe, let it settle, then tap. At an omission cut, retain the target’s approximate position and motion direction where the real footage allows. Avoid zooms and decorative whole-frame pans. This applies Smith’s account to UI footage; it is an inference, not a tested app-specific prescription.
- **Story decision:** Use the goal sequence as the edit structure: choose dinner → notice missing butter → save butter for next shop → resolve tonight’s substitution → finish and update pantry. Trim redundant navigation within those goals; do not omit the state changes that explain causality. This is an application of Zacks et al., not proof that this structure converts viewers.

### Gaps

- No selected study directly compares short dissolves with clean cuts in text-heavy mobile app demos. Do not claim that research proves 133 ms dissolves improve clarity, or that all dissolves harm it. Compare both treatments on the actual footage. As an editorial judgment, avoid overlapping two dense text screens during a dissolve and avoid adding dissolves over the app’s own transitions.
- These sources do not establish an optimal easing curve or gesture duration.

## How can the demo become simpler and faster without becoming hard to read?

### Takeaway

Remove information that does not advance the story, and spend the recovered time on the few states the viewer must understand. Reading time must depend on the actual visible text and audience. [Mayer and Moreno, 2003](https://carpentries.github.io/instructor-training/files/papers/mayer-reduce-cognitive-load-2003.pdf); [Brysbaert, 2019](https://biblio.ugent.be/publication/8647789)

### Cited Findings

- **Mayer and Moreno, “Nine Ways to Reduce Cognitive Load in Multimedia Learning,” Educational Psychologist 38(1), 2003, pp. 43–52.** Their research synthesis describes removing extraneous material and signaling important information. Concise narrated animations outperformed embellished versions on transfer tests in the cited experiments. The paper also warns that some recommendations had preliminary evidence. These were learning tasks, not silent promotional videos; transfer scores do not demonstrate marketing effectiveness. [Original paper PDF](https://carpentries.github.io/instructor-training/files/papers/mayer-reduce-cognitive-load-2003.pdf); [publisher DOI, access blocked during this research](https://doi.org/10.1207/S15326985EP3801_6)
- **Marc Brysbaert, “How many words do we read per minute? A review and meta-analysis of reading rate,” Journal of Memory and Language 109, 2019.** Across 190 studies with 18,573 participants, average adult English silent reading was estimated at 238 words per minute for nonfiction, with most adults around 175–300. Rates vary by age, language familiarity, and individual reader. These are text-reading measurements, not a guaranteed rate for tiny moving UI text. [Author’s university record and paper](https://biblio.ugent.be/publication/8647789)

### Inferences

- **Editing decision:** Show the weekly plan once with other meals visible, the recipe photo once, the missing-butter row, and the completed grocery item. Omit routine amount/unit input and repeated back navigation where causality remains clear. Keep the real UI; simplification happens through selection and pacing, not fabricated screens. Use the tap itself as the cue instead of competing rings, trails, labels, and sound on every action. This applies the learning literature cautiously.
- **Timing decision:** Count the answer’s visible words. For example, 30 words take about 7.6 seconds at the meta-analytic mean, or 10.3 seconds at 175 wpm, before finding the text or interpreting the screen. Those calculations are planning checks, not universal hold times. Protect a stationary answer hold and reduce idle navigation first. If too long, ask a naturally concise genuine question; never rewrite the model’s recorded answer.

### Gaps

- The selected papers do not prove a 46-second runtime or a 6.5-second answer hold is optimal. Test the finished video silently at its intended phone size and assess whether unfamiliar viewers can explain the butter/olive-oil distinction and final pantry result.

## Should music and tap sounds make the demo feel more polished?

### Takeaway

Use sound as an optional mood layer. The story must survive silence; adding auditory detail can compete with comprehension in some contexts. [Moreno and Mayer, 2000](https://tecfa.unige.ch/tecfa/teaching/methodo/Moreno_Mayer00.pdf)

### Cited Findings

- **Moreno and Mayer, “A Coherence Effect in Multimedia Learning: The Case for Minimizing Irrelevant Sounds in the Design of Multimedia Instructional Messages,” Journal of Educational Psychology 92(1), 2000, pp. 117–125.** Two experiments compared narrated educational animations with music, sounds, both, or neither. Music groups performed worse on retention and transfer; sound effects harmed performance in the second experiment. Each experiment recruited 75 college students. The material included narration and technical explanations, unlike this silent app demo. [Original paper, University of Geneva-hosted PDF](https://tecfa.unige.ch/tecfa/teaching/methodo/Moreno_Mayer00.pdf)

### Inferences

- Compare a restrained instrumental mix with a silent version. Keep music quiet during the AI answer, avoid a sound on every tap, and let the ending resolve without adding a new visual message. This is an editorial experiment informed by the paper, not evidence that silence outperforms music in advertising.

### Gaps

- These papers provide no measured optimum for music loudness, beat synchronization, tap volume, brand preference, sales, or conversion. They also reveal no proprietary Apple production process. Judge proposed variants by visible continuity, comprehension, natural interaction, and the user’s preference.
