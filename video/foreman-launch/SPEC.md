GOAL:    A judge understands, from one watch, that Foreman lets two people's coding agents edit one repo at once, down to the function, and hand work over without merge conflicts. Then they remember the name.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps
TIME:    58 s x 30 = 1740 frames, no music (silent cut)
LOOK:    Product world: VS Code Dark+ (ground #1E1E1E, sidebar #252526, activity bar #333333, panel border #3C3C3C, text #D4D4D4, line numbers #858585), code and UI rebuilt from the real extension at 1.6x size (code 30 px Menlo/mono, lens line 22 px).
         People: Rishikhesh = blue #378ADD, Joel-Marc = orange #D85A30, warnings = amber #EF9F27, errors = #F14C4C. Lock stripe = 6 px left border plus a 12% tint of the holder's colour. Cursor line = 10 px border plus a 25% tint.
         Brand world: a solid blue #378ADD flood. End card: white #FFFFFF ground, ink #1E1E1E.
         Titles: Archivo Black 84 px, -1% tracking, white on the product world and ink on white. One accent word per title in the holder's colour.
         UI text: Inter 400/700. No grain, no glow, no vignette.
OBJECTS: VS Code window (title bar with traffic lights, activity bar with the Foreman lock icon, editor tabs, code with line numbers, the CodeLens line above each function), the Foreman sidebar (welcome buttons, Room code, People, Requests), the VS Code quick pick, the VS Code modal dialog, the VS Code notification toast with buttons, the Claude Code terminal (dark, monospace), the git merge-conflict block.
MOTION:  arrivals expo.out 0.5 s; camera moves power2.inOut 0.6 s; exits power3.in 0.25 s; title words blur 6 px to 0 over 0.13 s, 0.067 s apart, no translate; colour flips 0.35 s power2.inOut; UI states change instantly, as in the real product.
SHOTS:
  0.0-4.5   Hook: split screen, two VS Code windows with Claude typing in both into validateToken. Title "Two agents. One file."
  4.5-9.0   Tension: the two windows slam together into a merge-conflict block filling the frame. Title "You find out at merge time."
  9.0-12.0  Reveal: the conflict collapses into the Foreman lock icon; blue flood; title "Foreman", sub "Google Docs for coding agents".
  12.0-23.5 Join: split again. Host clicks Start a room, the GitHub dialog appears, the host picks blue, and a toast shows Room code F9CS-JFS7. The friend clicks Join a room, types F9CS-JFS7, picks orange, and sees "Waiting for @Rishikhesh". The host's toast asks to let @Joel-Marc join; the host clicks Allow, and People lists both.
  23.5-31.0 Proof 1, locks: one editor full frame. Lens and stripe on validateToken (Joel-Marc, orange); the host's edits to getUser appear (blue). Title "Lock the function, not the file".
  31.0-36.5 Proof 2, refusal: a terminal slides up showing the real Foreman deny text; the validateToken lens gains "⏳ claude@Rishikhesh waiting". Title "Wait in line, not in a conflict".
  36.5-41.5 Proof 3, caller warning: amber underline under getUser with the warning on its lens line; red squiggle "Expected 1 arguments, but got 2." Title "Warned before it breaks".
  41.5-49.5 Payoff, handoff: the friend's terminal types "commit", then "[main 4ac7878] validateToken: check issuer". The stripe flips orange to blue, the code becomes the merged version, the toast reads "validateToken is yours now…", and the host terminal reads "Foreman already merged 4ac7878". Amber and red disappear.
  49.5-53.5 Claim: the host commits; every stripe clears; title "Two agents. Zero merge conflicts."
  53.5-58.0 End card: the lock mark carried in, the wordmark wipes in, sub "Google Docs for coding agents", CTA github.com/Rishikhesh/hauntedHacks, with "Built on Terse Durable Actors + Agent Relay".
BANNED:  a dark void with small floating UI (product UI fills 60%+ of the frame); glow, particles, gradients; three cards in a row; a title over a dimmed screenshot; the logo docked in a corner; every element sliding up; invented UI (every string comes from the extension, hooks or git); Halloween styling.
QA:      2.0 s both windows typing; 7.0 s conflict readable; 10.5 s name readable; 16.5 s room code toast; 21.0 s Allow toast; 27.0 s two stripes and lenses; 34.0 s deny text and the waiting lens; 39.5 s amber and red; 46.0 s stripe flipped blue with the merged code; 51.5 s clean file and claim; 56.5 s end card.
