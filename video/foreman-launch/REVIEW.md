# Review: Foreman launch film (58 s, 1920x1080, 30 fps)

## Creative calls

- **Built:** storyline A, "Two laptops, one function". It covers the split screen, the room join flow, locks, refusal, the caller warning, the handoff with an automatic merge, and an end card.
- **Not built:** B, "The function's passport" (one continuous take on `validateToken`), and C, "Type carries the argument" (kinetic type cut on the beat). Both are in `STORYLINES.md`.
- **Product UI is rebuilt, not recorded.** There are no screen recordings yet, so the VS Code pieces are rebuilt at about 1.85x size: editor, CodeLens lines, stripes, sidebar, quick pick, modal and toasts. Every string comes from the extension (`vscode-ext/src/extension.ts`, `view.ts`), the hooks (`cli/hook.ts` deny and handoff texts) or git. Commit `4ac7878` "validateToken: check issuer" is real, from the demo run.
- **The merge-conflict block in the hook is illustrative,** in the shape git writes.

## What was measured

- `hyperframes check` passes.
- `snapshot --review` produced the beat sheet, the five cut strips and the phone sheet. Every beat matches its shot in `SPEC.md`.
- Fixed in review:
  - code ligatures (`!==` rendered as a glyph);
  - a black fade at the cut into the editor and into the claim scene;
  - the hook-to-reveal cut, which now has a cause (the conflict shrinks into the lock);
  - an empty first frame, so the thumbnail now has the title;
  - two dead stretches, now filled with agent cursor moves;
  - low-contrast greys.

## Warnings kept on purpose

- **`film_silent`:** HeyGen isn't signed in, so there's no music source. The plan in `STORYLINES.md` is a minimal pulse held back until the handoff, a lock click on each lock, and one riser into the colour flip.
- **`text_below_floor`:** product UI text is 19–24 px, so the file fits on screen. On a phone the titles carry the story.
- **`line_unread`:** the long terminal and toast texts are shown for their look. The title above each states the point.

## Weakest shot and next steps

- **Weakest:** the join flow (12–23.5 s). It's dense, and the sidebar text is small. With more time I'd punch in on the room code toast and the Allow toast.
- **Better footage:** swap in real screen recordings of the live demo when you have them.
