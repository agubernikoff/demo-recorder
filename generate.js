// generate.js
// Usage: node generate.js <codebase-path> [output.config.json]
// Reads a Remix app codebase, sends it to Claude, and generates a demo-recorder config.
// Requires: ANTHROPIC_API_KEY env var

require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const codebasePath = process.argv[2];
const outputPath = process.argv[3] || "configs/generated.config.json";
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

if (!codebasePath || !fs.existsSync(codebasePath)) {
  console.error("Usage: node generate.js <codebase-path> [output.config.json]");
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY environment variable not set");
  process.exit(1);
}

// ─── Source collection ────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", "build", "public", ".cache", ".git", "dist"]);
const SOURCE_EXTS = [".tsx", ".ts", ".jsx", ".js", ".css"];

function walkDir(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (SOURCE_EXTS.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function buildSourceContext(base) {
  // Routes and components first — most important for selector accuracy
  const priorityFiles = [
    ...walkDir(path.join(base, "app/routes")),
    ...walkDir(path.join(base, "app/components")),
  ];

  // CSS and app root for class names and layout context
  const supportFiles = [
    ...walkDir(path.join(base, "app/styles")),
    ...["app/root.tsx", "app/root.jsx", "app/root.ts"].map((f) =>
      path.join(base, f)
    ).filter(fs.existsSync),
  ];

  const allFiles = [...new Set([...priorityFiles, ...supportFiles])];

  const MAX_CHARS = 90000; // ~22k tokens, leaves room for response
  let context = "";

  for (const file of allFiles) {
    if (context.length >= MAX_CHARS) {
      console.log(`   (truncated at ${allFiles.indexOf(file)}/${allFiles.length} files)`);
      break;
    }
    try {
      const content = fs.readFileSync(file, "utf8");
      const rel = path.relative(base, file);
      context += `\n\n=== ${rel} ===\n${content}`;
    } catch {}
  }

  return { context, fileCount: allFiles.length };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`📁 Reading codebase: ${codebasePath}`);
  const { context, fileCount } = buildSourceContext(codebasePath);
  console.log(`   ${fileCount} files, ${Math.round(context.length / 1000)}k chars`);

  const client = new Anthropic();

  const prompt = `You are generating a config for a Playwright-based demo recorder that creates marketing/product demo videos.

The tool navigates a real browser, moves the mouse naturally, hovers elements to show hover states, clicks, scrolls, and records everything to video.

CONFIG FORMAT:
{
  "url": "<starting URL>",
  "output": "<filename without extension>",
  "viewport": { "width": 1280, "height": 800 },
  "hoverDwell": <default hover duration ms>,
  "postScrollWait": <wait after scroll ms>,
  "interactions": [ ...steps ]
}

STEP TYPES:
{ "type": "wait", "wait": ms }
{ "type": "hover", "selector": "css", "dwell": ms }
{ "type": "hoverAll", "selector": "css", "dwell": ms }        ← hovers each match, top to bottom
{ "type": "hoverContainer", "selector": "css", "dwell": ms }  ← hover + drift through a container
{ "type": "click", "selector": "css", "dwell": ms }
{ "type": "navigate", "url": "https://..." }
{ "type": "scroll", "to": pixelY, "duration": ms }
{ "type": "scrollToTop" }
{ "type": "scrollToBottom" }
{ "type": "type", "selector": "css", "text": "..." }

GUIDELINES:
- Use EXACT CSS class names from the source code — no guessing
- Cover 3-5 pages that best showcase the product
- Start on the home page with a 1500ms wait, then show the nav
- Navigate to the most visually rich / important pages
- On each page: hover interactive elements, scroll through content, show hover states
- Keep timing natural: hoverDwell 400-600ms, post-nav waits 700-1000ms
- End back on the home page if it makes narrative sense
- Think like a designer making a polished product demo, not a QA tester

Here is the Remix app source code:
${context}

Output ONLY the raw JSON object — no markdown fences, no explanation, no comments.`;

  console.log("\n🤖 Asking Claude to generate config...");

  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  let text = message.content[0].text.trim();

  // Strip markdown fences if Claude added them anyway
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  try {
    const config = JSON.parse(text);
    fs.writeFileSync(outputPath, JSON.stringify(config, null, 2));
    const navCount = config.interactions.filter((s) => s.type === "navigate").length;
    console.log(`\n✅ Config written: ${outputPath}`);
    console.log(`   ${config.interactions.length} interactions across ${navCount + 1} pages`);
    console.log(`\nRun it:\n   node demo-recorder.js ${outputPath}`);
  } catch (e) {
    const rawPath = outputPath + ".raw.txt";
    fs.writeFileSync(rawPath, text);
    console.error(`\n❌ Failed to parse response as JSON: ${e.message}`);
    console.error(`   Raw response saved to: ${rawPath}`);
  }
})();
