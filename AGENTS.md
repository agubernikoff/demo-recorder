# AGENTS.md — demo-recorder

Instructions for AI agents working on this codebase.

---

## What this project is

A Playwright-based tool that records polished product demo videos from a JSON config. It opens a real browser, moves the mouse naturally along Bezier curves, hovers elements, scrolls, clicks, and saves video. There is also a `generate.js` that uses Claude Opus to produce a config from a Remix app's source code.

Two files matter:

- `demo-recorder.js` — the recorder. All step logic lives in `runStep()`.
- `generate.js` — Claude-powered config generator. Reads a Remix codebase and calls the Anthropic API.

---

## Architecture

### Mouse movement
All mouse movement goes through `moveTo(page, x, y)`. It tracks `_mouseX`/`_mouseY` globals and moves along a quadratic Bezier curve with easing. Never call `page.mouse.move()` directly — always use `moveTo`.

### Page scroll
`smoothScroll(page, targetY, durationMs)` animates `window.scrollTo` from Node.js using a frame loop. Used by all page-level scroll steps.

### Element scroll
`smoothScrollElement(page, selector, targetScrollTop, durationMs)` runs the animation entirely inside the browser via `requestAnimationFrame` using a single `page.evaluate()` call. This is intentional — it avoids competing with Playwright's IPC channel during concurrent hover steps. Do not revert this to a Node.js frame loop.

### Scroll-to-reveal
`scrollToElement(page, el)` scrolls the page just enough to reveal an element — it never snaps to top. `getScrollTopToRevealInContainer(page, containerSel, itemEl)` does the same but for an overflow container.

### Step runner
`runStep(page, step)` is a switch on `step.type`. It is recursive — `parallel` and `sequence` both call `runStep` on child steps. When adding a new step type, add a case here.

### Config globals
`HOVER_DWELL`, `POST_SCROLL`, `VIEWPORT`, `AUTO_DISMISS` are read from config at startup and used as defaults throughout. Do not hardcode timing values inside step handlers — reference these constants.

`AUTO_DISMISS` (`autoDismissPopups`, default `true`) gates the automatic `dismissPopups()` call that runs after the initial page load and after every `navigate` step. When `false`, the config is responsible for dismissing popups manually via `click` steps.

---

## Adding a new step type

1. Add a `case "myStep":` block in the `runStep` switch in `demo-recorder.js`
2. Destructure any new fields from `step` at the top of the case (not from the outer destructure on line ~179, which only covers common fields)
3. Update the prompt string in `generate.js` so Claude knows the new step exists
4. Document it in `README.md`

---

## Key patterns

### Non-blocking (fire-and-forget) async work
Use an immediately-invoked async arrow with no `await`:
```js
(async () => {
  await someAsyncThing();
})();
```
Used by `triggerScroll` in `hoverAll` to fire a background element scroll without blocking hover iteration.

### "to": "bottom" for scrollElement
When `to === "bottom"`, the step reads `el.scrollHeight - el.clientHeight` via `page.$eval` before calling `smoothScrollElement`. This pattern should be reused for any future step that needs runtime element dimensions.

### triggerScroll on hoverAll
Fires once per `hoverAll` invocation when the first item whose `box.y + box.height/2 > VIEWPORT.height * threshold` is reached. The `scrollTriggered` boolean prevents double-firing. Default threshold is `0.6`.

### parallel + sequence
`parallel` uses `Promise.all`. `sequence` is a sequential for-loop over `runStep`. These are safe to nest arbitrarily. The only caveat: avoid putting two hover steps (which both call `moveTo`) in parallel branches — they share the `_mouseX`/`_mouseY` globals and will corrupt each other's Bezier paths.

---

## What not to change

- `moveTo` — the Bezier curve math is intentional. Don't simplify to linear.
- `smoothScrollElement` — must stay as a single `page.evaluate` with `requestAnimationFrame`. The frame-loop-from-Node approach was replaced specifically because it caused IPC races during `parallel` steps.
- `scrollToElement` — the "minimum scroll" logic (never snaps to top) is intentional for demo aesthetics.
- `jitter()` — applied to most dwell times so the recording doesn't feel mechanical. Always wrap dwell values in `jitter()`.

---

## generate.js notes

- Uses `claude-opus-4-6` — don't downgrade, selector accuracy depends on model capability
- Source context is capped at ~90k chars to stay within token budget. Priority order: routes → components → styles → root
- The prompt instructs Claude to output raw JSON only. The script strips markdown fences defensively.
- If JSON parsing fails, the raw response is saved as `<output>.raw.txt` for inspection.
