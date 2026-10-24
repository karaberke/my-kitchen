# Apple guidance for a genuine My Kitchen app demo

Research completed 23 October 2026. Scope: six primary Apple sources, including three WWDC lecture transcripts, two marketing guidance pages, and Apple's description of one campaign. Lecture transcripts and web pages were read; the campaign film itself was not watched. These sources establish public design and marketing guidance, not Apple's internal film-production process. Proposed timings below are editing experiments, not Apple specifications or research findings.

## How can the demo direct attention while preserving continuity?

### Takeaway

Make the intended action easy to follow, then let its result settle. A smooth recording depends on coherent motion and immediate feedback as well as frame rate; smoothing every scene boundary is not a substitute for this continuity.

### Cited Findings

- Apple's _Designing Fluid Interfaces_ lecture explicitly distinguishes fluidity from simply achieving 60 fps. It emphasizes response latency, direct manipulation, and the ability for motion to follow changing intent. This is interface-design guidance, transferable by inference to filming an interface. — [WWDC18: Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803/)
- _Animate with springs_ identifies continuity of both position and velocity as an animation goal. Linear movement can have abrupt speed changes at its start and stop. Ease-in/out is continuous when starting from rest; springs additionally preserve an initial gesture velocity. — [WWDC23: Animate with springs](https://developer.apple.com/videos/play/wwdc2023/10158/)
- The same lecture explains that springs can have no bounce and that gradual settling can feel natural. It does not prescribe bouncing as the recognizable Apple look. Short quotation: “continuous position and velocity.” — [WWDC23: Animate with springs](https://developer.apple.com/videos/play/wwdc2023/10158/)
- Apple's app-preview guidance recommends native UI capture rather than zooming into the interface. It permits touch hotspots and straightforward dissolves/fades, while requiring that transitions avoid suggesting features the app lacks. — [Apple: App Previews](https://developer.apple.com/app-store/app-previews/)

### Inferences

- Preserve the real page movement and its direction. Prefer a single purposeful scroll that decelerates into a useful reading position; remove corrective up/down hunting before the take. A 500–750 ms settled swipe is a starting experiment, not an Apple rule.
- Do not apply a dissolve during a scroll. Keep motion continuous inside a screen; use a short neutral transition only when omitted time or navigation needs bridging. A four-frame dissolve may hide a discontinuity, but double-exposed text can be worse than a clean cut.
- Let the viewer find a button before the tap. Start with a brief 200–350 ms pause, followed by the actual UI reaction. These intervals should vary with context so the performance does not become metronomic.
- Avoid artificial parallax, bounce, punch-in zooms, or fake shared-element transitions. Our real app and its existing motion are the subject. Keep the same phone viewport throughout.
- A recording with a slow settled scroll and clear destination is more useful than interpolating 30 fps footage to 60 fps and calling it native smoothness.

### Gaps

- These sources do not reveal the frame rate, easing parameters, edit points, or proprietary production software behind Apple's advertising. No such workflow is asserted here.
- We have not measured a viewer preference for any proposed scroll duration. Judge the output in motion at normal phone size, not only as a contact sheet.

## How should the story be simplified and paced as marketing?

### Takeaway

The useful model is a recognizable problem followed by a visible resolution. Our central message is that dinner can continue even when an ingredient is missing; the other features support that one outcome.

### Cited Findings

- Apple's _Presenting Design Work_ recommends clarifying the bigger picture before details, making the situation relatable, defining a problem simply, using a beginning/middle/end, and removing information unnecessary to the message. It describes an anticipated payoff: “Design for the aha moment.” This is presentation guidance rather than a filmmaking manual. — [WWDC18: Presenting Design Work](https://developer.apple.com/videos/play/wwdc2018/811/)
- Apple's asset guidance recommends beginning with a compelling benefit, allowing viewers time to understand cuts, and avoiding very fast visuals. It recommends a clear focal point and warns that clutter dilutes a single idea. — [Apple: App Store Asset Best Practices](https://developer.apple.com/app-store/asset-best-practices/)
- Apple describes its _Underdogs_ campaign as colleagues accomplishing a high-stakes presentation in two days using a suite of apps. Its accompanying editorial explains concrete actions such as annotating an image and collaborating on files. This is evidence for that campaign's task-led premise, not an observed shot-by-shot analysis. — [Apple: Be an Office Hero](https://apps.apple.com/us/story/id1455561115)
- App previews are meant to tell a cohesive story through captured app footage and remain inside the app. Apple's App Store preview format has a 30-second maximum, which does not impose a limit on our general promotional film. — [Apple: App Previews](https://developer.apple.com/app-store/app-previews/)

### Inferences

- Keep the chronological cause-and-effect chain: tonight's meal → missing butter → butter saved for the next shop → olive oil advice → recorded substitution → pantry confirmation. Each retained shot should either establish the problem, perform a meaningful action, or show proof.
- Start with Today and one or two neighboring meals visible, then open the photo quickly. The fully populated week can be visible without making viewers read all seven entries. This preserves the user's lived-in-week request while reducing setup.
- Treat the pasta photo as a short emotional payoff and the meal name as the visual anchor. A generous photo hold is more compelling than browsing all recipe metadata.
- Remove routine quantity, unit, and navigation administration from the edit. Preserve enough manual butter entry to communicate intent, plus the resulting grocery item. Never imply butter was automatically added.
- The assistant response is a key benefit and a reading task. Shorten surrounding overhead before shortening that hold. Keep the actual response unaltered; use purposeful scrolling if necessary.
- The final pantry confirmation is the story's resolution. Keep it long enough to see it succeeded, and avoid tacking on a second feature tour afterward.

### Gaps

- The _Underdogs_ description cannot establish exact cut rhythm, framing, camera movement, music synchronization, or production methods. We should not claim to have watched it.
- None of these sources proves that one proposed version will improve conversion. The alternatives need direct comparison and ideally a few unfamiliar viewers.

## What should transfer to musical timing and alternative edits?

### Takeaway

Use sound to connect the story and reinforce its calm pace. Make two or three materially different edits so the choice is about clarity and feeling, not just a faster playback multiplier.

### Cited Findings

- Apple recommends a single musical score across a preview for continuity, and allows interface sound effects to reinforce app functionality. — [Apple: App Previews](https://developer.apple.com/app-store/app-previews/)
- Apple's current asset guidance says the creative should work silently first, with audio contributing texture. It favors restrained music over heavy effects and cautions against abrupt loud moments. — [Apple: App Store Asset Best Practices](https://developer.apple.com/app-store/asset-best-practices/)

### Inferences

- Keep one quiet instrumental bed and a small number of low-level interaction accents. Do not emphasize every tap; that exposes the machinery of the task and can make scripted use feel mechanical.
- Let three or four narrative arrivals coincide with musical phrase changes: opening recipe, confirmed grocery item, useful answer, final success. Do not force every tap or scroll onto the beat. A slightly loose performance feels human while the larger edit feels composed.
- Resolve the musical phrase on the success state, then allow a short tail. No dramatic build is needed for a small everyday success.
- **A — Quiet confidence, roughly 40–42 seconds, recommended.** Today with neighboring meals 4 s; photo and missing butter 6 s; manual grocery action/result 6 s; question and readable genuine answer 12 s; cooking/substitution 10 s; success 3 s. Preserve action speed, trim overhead, use at most two understated scene bridges. This gives the story space without the original tutorial rhythm.
- **B — Everyday momentum, roughly 34–36 seconds.** Same chronology, shorter opening and routine entry, cleaner direct cuts at settled states, slightly more rhythmic instrumental pulse. Preserve at least the same answer-reading opportunity by taking time elsewhere. The experiment tests urgency without speed-running the interface.
- **C — Continuous companion, roughly 44–46 seconds.** Mostly uninterrupted action chains, natural native transitions, the fewest editorial dissolves, gentler music, longer read holds. This tests credibility and continuity against the faster version rather than simply splitting their durations.
- Prefer A if the new viewer can explain the butter/olive-oil distinction after one silent viewing. Prefer B only if it passes that same test. Ask a reviewer to identify what was planned, what was missing, what was added, what was substituted, and what happened to the pantry without prior briefing.

### Gaps

- Exact BPM, audio loudness, pause lengths, and transition durations are our production decisions. No Apple source here establishes universal optimal values.
- A beautiful montage is not sufficient evidence that the silent story is understandable. The final render needs real-time review in addition to metadata checks.
