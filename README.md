# demo-recorder

Records polished product demo videos from a config file. Opens a real browser with Playwright, moves the mouse naturally along curved paths, hovers elements to trigger hover states, scrolls, clicks, and saves everything to `.webm` + `.mp4`.

---

## Requirements

- Node.js
- `npm install`
- `ffmpeg` — for mp4 conversion (`brew install ffmpeg`)
- `ANTHROPIC_API_KEY` — only needed for `generate.js`

---

## Usage

### Run a config

```bash
node demo-recorder.js configs/my-site.demo.config.json
```

### Generate a config from a Remix codebase

```bash
ANTHROPIC_API_KEY=... node generate.js /path/to/remix-app [configs/output.config.json]
```

Reads routes, components, and styles — sends them to Claude Opus, which produces a config with accurate CSS selectors and natural interaction timing. Defaults to `configs/generated.config.json`.

### Auto-discovery mode (no config)

```bash
DEMO_URL=https://example.com DEMO_OUTPUT=output/my-demo node demo-recorder.js
```

Discovers nav links automatically and scrolls + interacts with each page. `DEMO_URL` and `DEMO_OUTPUT` are overridden by any values in the config file if one is provided.

---

## Config format

```json
{
  "url": "https://example.com",
  "output": "output/my-demo/my-demo",
  "viewport": { "width": 1280, "height": 800 },
  "hoverDwell": 500,
  "postScrollWait": 700,
  "autoDismissPopups": true,
  "interactions": []
}
```

| Field               | Default               | Description                                                                                                              |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `url`               | `https://example.com` | Starting URL                                                                                                             |
| `output`            | `demo`                | Output path without extension. Use `output/<name>/<name>` to group files in a subfolder.                                 |
| `viewport`          | `1280×800`            | Browser window size                                                                                                      |
| `hoverDwell`        | `900ms`               | Default hover duration                                                                                                   |
| `postScrollWait`    | `1400ms`              | Pause after page-level scrolls                                                                                           |
| `autoDismissPopups` | `true`                | Auto-dismiss popups after initial load and each `navigate`. Set to `false` to handle popups manually with `click` steps. |

---

## Step types

### Navigation & timing

```json
{ "type": "wait", "wait": 1000 }
{ "type": "navigate", "url": "https://example.com/page" }
```

`navigate` finds the matching `<a>` on the page and clicks it naturally. Falls back to `goto` if no link is found.

### Hover

```json
{ "type": "hover", "selector": ".my-button", "dwell": 600 }
```

Scrolls the element into view, moves the mouse along a curved Bezier path, dwells.

```json
{ "type": "hoverAll", "selector": "nav a", "dwell": 400 }
```

Finds all matching elements, sorts them top-to-bottom, and hovers each one.

**Options:**

- `scrollContainer` — scroll a specific overflow container to reveal each item instead of scrolling the page
- `triggerScroll` — stop hovering and scroll an element once the mouse reaches a threshold Y position in the viewport; the next step waits for the scroll to complete

```json
{
  "type": "hoverAll",
  "selector": ".list-item",
  "dwell": 300,
  "scrollContainer": ".scrollable-list",
  "triggerScroll": {
    "selector": ".content-panel",
    "to": "bottom",
    "duration": 2000,
    "threshold": 0.6
  }
}
```

`triggerScroll` fires once when the first item whose center Y exceeds `threshold × viewportHeight` is reached. Hovering stops immediately, the scroll animation runs, and the next step begins only after the scroll completes. Default threshold: `0.6`.

```json
{
  "type": "hoverContainer",
  "selector": ".card-grid",
  "dwell": 800,
  "drift": true
}
```

Hovers the container, then optionally drifts the mouse downward through it. Set `"drift": false` to hover without drifting.

### Click

```json
{ "type": "click", "selector": ".button", "dwell": 400 }
```

### Page scroll

```json
{ "type": "scroll", "to": 800, "duration": 1200 }
{ "type": "scrollToTop", "duration": 1800 }
{ "type": "scrollToBottom", "duration": 2000 }
{ "type": "autoScroll" }
```

`autoScroll` scrolls down the whole page in viewport-sized steps, interacting with visible elements at each stop.

| Step             | `duration` default |
| ---------------- | ------------------ |
| `scroll`         | 1200ms             |
| `scrollToTop`    | 1800ms             |
| `scrollToBottom` | 2000ms             |

After each page scroll, the recorder waits `postScrollWait` ms before continuing.

### Element scroll

```json
{ "type": "scrollElement", "selector": ".sidebar", "to": 400, "duration": 1000 }
{ "type": "scrollElement", "selector": ".sidebar", "to": "bottom", "duration": 1500 }
```

Scrolls inside a specific overflow element. `"to": "bottom"` reads `scrollHeight - clientHeight` at runtime. Animation runs entirely inside the browser via `requestAnimationFrame`. Default `duration`: 1000ms. No `postScrollWait` is applied — this is intentional for use inside `parallel` branches.

### Type

```json
{ "type": "type", "selector": "input.search", "text": "hello" }
```

### Concurrency

```json
{
  "type": "parallel",
  "steps": [
    { "type": "sequence", "steps": [ ...stepsA ] },
    { "type": "scrollElement", "selector": ".panel", "to": "bottom", "duration": 2000 }
  ]
}
```

`parallel` runs all child steps concurrently with `Promise.all`. `sequence` runs child steps in order (used as a child of `parallel` to preserve ordering within one branch).

Safe to combine `scrollElement` with hover steps in parallel — the scroll animation runs inside the browser and doesn't compete with Playwright's mouse movement IPC.

---

## Project structure

```
demo-recorder/
├── demo-recorder.js        # recorder
├── generate.js             # Claude-powered config generator
├── configs/                # demo config files
│   └── *.demo.config.json
├── output/                 # generated videos — gitignored
├── README.md
├── AGENTS.md
└── package.json
```

Config files set `"output": "output/<name>"` so videos land in `output/` automatically. The directory is created at runtime if it doesn't exist.

## Output

Two files are written to `output/` (or wherever `"output"` points in the config):

- `<output>.webm` — raw recording
- `<output>.mp4` — converted via ffmpeg (`libx264`, CRF 18)
