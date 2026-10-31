# Review: Foreman team film (90 s, 3 people, voiceover)

## What was built

- **People:** three, with turzobose as the third agent in green.
- **Voiceover:** Kokoro (`af_heart`) generated on this laptop, with no HeyGen account. Script in `VOICEOVER.md`, audio in `assets/voice/`.
- **Tagline:** "Many agents. One codebase. Zero collisions." throughout. The old tagline is gone.
- **Product UI:** rebuilt from the extension's real strings, as in the first film. Commit `4ac7878` is real.
- **Illustrative content:** the three-way merge conflict and the TypeError line.

## What was measured

- `hyperframes check` passes.
- Fixed:
  - the end card overlapping the code underneath it;
  - five dead stretches, now filled with Claude's real "Updated auth.ts" output, git's CONFLICT line, and agents working while they wait;
  - low-contrast highlight tints.
- I looked at 15 key frames.
- The voice audio was measured after rendering, but not listened to.

## Warnings kept on purpose

- **`text_below_floor`:** product UI text is under the phone-size floor so the whole file fits.
- **`line_unread`:** long terminal messages. The voice and the titles carry the point.
- **One contrast item:** a 4.26:1 syntax colour.

## Next

- Add a music bed under the voice (needs HeyGen or local MusicGen).
- Swap in real screen recordings when you have them.
