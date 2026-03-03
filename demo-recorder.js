// demo-recorder.js
// Usage: node demo-recorder.js [config.json]

const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── Load config ─────────────────────────────────────────────────────────────

const configPath = process.argv[2];
let config = {};

if (configPath && fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  console.log(`📋 Loaded config: ${configPath}`);
} else if (configPath) {
  console.error(`❌ Config file not found: ${configPath}`);
  process.exit(1);
} else {
  console.log(`⚡ No config — running auto-discovery mode`);
}

const URL = config.url || process.env.DEMO_URL || "https://example.com";
const OUTPUT = config.output || process.env.DEMO_OUTPUT || "demo";
const VIEWPORT = config.viewport || { width: 1280, height: 800 };
const HOVER_DWELL = config.hoverDwell || 900;
const POST_SCROLL = config.postScrollWait || 1400;
const STEPS = config.interactions || null;
const AUTO_DISMISS = config.autoDismissPopups ?? true;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Slight timing jitter so dwells don't feel mechanical
function jitter(ms, pct = 0.15) {
  return ms * (1 + (Math.random() * 2 - 1) * pct);
}

// Animate scroll from Node.js side — one evaluate per frame with a sleep
// in between so the browser actually renders each intermediate position.
// Runs the scroll animation entirely inside the browser via requestAnimationFrame
// so it doesn't compete with Playwright's IPC channel during concurrent hover steps.
async function smoothScrollElement(page, selector, targetScrollTop, durationMs = 1000) {
  await page.evaluate(([sel, targetY, duration]) => {
    return new Promise((resolve) => {
      const container = document.querySelector(sel);
      if (!container) return resolve();
      const startY = container.scrollTop;
      const delta = targetY - startY;
      if (Math.abs(delta) < 10) return resolve();
      const startTime = performance.now();
      function frame(now) {
        const t = Math.min((now - startTime) / duration, 1);
        const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        container.scrollTop = startY + delta * ease;
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }, [selector, targetScrollTop, durationMs]);
}

// Returns the scrollTop needed to reveal `itemEl` inside the container
// matched by `containerSel`, or null if it's already visible.
async function getScrollTopToRevealInContainer(page, containerSel, itemEl, padding = 20) {
  return await itemEl.evaluate((item, [sel, padding]) => {
    const container = document.querySelector(sel);
    if (!container) return null;
    const itemRect = item.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const relTop = itemRect.top - containerRect.top;
    const relBottom = itemRect.bottom - containerRect.top;
    const containerH = container.clientHeight;
    const currentScrollTop = container.scrollTop;
    if (relTop >= padding && relBottom <= containerH) return null;
    if (relBottom > containerH) return currentScrollTop + (relBottom - containerH) + padding;
    return currentScrollTop + relTop - padding;
  }, [containerSel, padding]);
}

async function smoothScroll(page, targetY, durationMs = 1200) {
  const startY = await page.evaluate(() => window.scrollY);
  const delta = targetY - startY;
  if (Math.abs(delta) < 10) return;

  const FRAME_MS = 16;
  const steps = Math.max(20, Math.round(durationMs / FRAME_MS));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    await page.evaluate((y) => window.scrollTo(0, y), Math.round(startY + delta * ease));
    await sleep(FRAME_MS);
  }
  await sleep(jitter(120));
}

async function dismissPopups(page) {
  const closeSelectors = [
    'button[aria-label*="close" i]',
    'button[aria-label*="dismiss" i]',
    '[class*="close"]',
    '[class*="dismiss"]',
    '[class*="modal"] button',
    '[class*="popup"] button',
    '[class*="overlay"] button',
    'button:has-text("×")',
    'button:has-text("✕")',
    'button:has-text("Close")',
    'button:has-text("No thanks")',
    'button:has-text("Maybe later")',
    'button:has-text("x")',
    'button:has-text("X")',
  ];
  for (const sel of closeSelectors) {
    try {
      const el = await page.$(sel);
      if (el && (await el.isVisible())) {
        await el.click();
        console.log(`   ✓ Dismissed popup: ${sel}`);
        await sleep(600);
        return;
      }
    } catch {}
  }
  await page.keyboard.press("Escape");
  await sleep(300);
}

async function getPageHeight(page) {
  return await page.evaluate(() => document.body.scrollHeight);
}

// Scroll the MINIMUM amount needed to reveal the element —
// never snaps to top, always uses the same smooth eased animation
async function scrollToElement(page, el, paddingTop = 80) {
  // Get all scroll data in one evaluate to avoid race conditions
  const { rectTop, rectBottom, rectHeight, viewH, currentY } = await el.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      rectTop: rect.top,
      rectBottom: rect.bottom,
      rectHeight: rect.height,
      viewH: window.innerHeight,
      currentY: window.scrollY,
    };
  });

  // Skip hidden/zero-height elements
  if (rectHeight < 5) return;

  // Already fully visible — don't touch scroll at all
  if (rectTop >= 0 && rectBottom <= viewH) return;

  let targetY;
  if (rectBottom > viewH) {
    // Element is below the fold — scroll down just enough to reveal it
    targetY = currentY + (rectBottom - viewH) + paddingTop;
  } else if (rectTop < 0) {
    // Element is above the viewport — scroll up just enough
    targetY = currentY + rectTop - paddingTop;
  } else {
    return;
  }

  targetY = Math.max(0, targetY);
  if (Math.abs(targetY - currentY) > 10) {
    await smoothScroll(page, targetY, 800);
  }
}

// Track mouse position so we can compute bezier control points
let _mouseX = 640,
  _mouseY = 400;

// Move mouse along a curved, eased path — much more natural than linear steps
async function moveTo(page, targetX, targetY) {
  const startX = _mouseX,
    startY = _mouseY;
  const dist = Math.hypot(targetX - startX, targetY - startY);
  if (dist < 3) {
    _mouseX = targetX;
    _mouseY = targetY;
    return;
  }

  const curve = Math.min(dist * 0.12, 60) * (Math.random() < 0.5 ? 1 : -1);
  const midX = (startX + targetX) / 2 - ((targetY - startY) / dist) * curve;
  const midY = (startY + targetY) / 2 + ((targetX - startX) / dist) * curve;

  const steps = Math.max(20, Math.min(80, Math.round(dist / 8)));
  const stepMs = 10;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const bx =
      (1 - ease) ** 2 * startX +
      2 * (1 - ease) * ease * midX +
      ease ** 2 * targetX;
    const by =
      (1 - ease) ** 2 * startY +
      2 * (1 - ease) * ease * midY +
      ease ** 2 * targetY;
    await page.mouse.move(Math.round(bx), Math.round(by));
    await sleep(stepMs + Math.random() * 5);
  }
  _mouseX = targetX;
  _mouseY = targetY;
}

// ─── Step runner ──────────────────────────────────────────────────────────────

async function runStep(page, step) {
  if (!step.type) return;

  const { type, selector, to, text, duration, wait, url: stepUrl } = step;
  const dwell = step.dwell ?? HOVER_DWELL;

  switch (type) {
    case "hover": {
      try {
        const el = await page.$(selector);
        if (el) {
          await scrollToElement(page, el);
          const box = await el.boundingBox();
          if (box)
            await moveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          console.log(`   → hover: ${selector}`);
          await sleep(jitter(dwell));
        } else {
          console.warn(`   ⚠️  Not found: ${selector}`);
        }
      } catch (e) {
        console.warn(
          `   ⚠️  hover failed (${selector}): ${e.message.split("\n")[0]}`,
        );
      }
      break;
    }

    case "hoverAll": {
      try {
        const els = await page.$$(selector);

        const withDocTop = (
          await Promise.all(
            els.map(async (el) => {
              try {
                const docTop = await el.evaluate((node) => {
                  const r = node.getBoundingClientRect();
                  return r.top + window.scrollY;
                });
                return { el, docTop };
              } catch {
                return null;
              }
            }),
          )
        ).filter(Boolean);

        withDocTop.sort((a, b) => a.docTop - b.docTop);

        console.log(
          `   → hoverAll: ${selector} (${withDocTop.length} elements)`,
        );

        let scrollTriggered = false;
        let scrollPromise = null;
        const isCascade = !!step.cascade;

        for (const { el } of withDocTop) {
          if (!isCascade) {
            if (step.scrollContainer) {
              const containerEl = await page.$(step.scrollContainer);
              if (containerEl) await scrollToElement(page, containerEl);
              const targetScrollTop = await getScrollTopToRevealInContainer(page, step.scrollContainer, el);
              if (targetScrollTop !== null) {
                await smoothScrollElement(page, step.scrollContainer, targetScrollTop, 600);
                await sleep(80);
              }
            } else {
              await scrollToElement(page, el);
            }
          }

          const box = await el.boundingBox();
          if (!box) continue;

          // When the mouse reaches the threshold, stop hovering immediately and scroll
          if (step.triggerScroll && !scrollTriggered) {
            const threshold = step.triggerScroll.threshold ?? 0.6;
            if (box.y + box.height / 2 > VIEWPORT.height * threshold) {
              scrollTriggered = true;
              scrollPromise = (async () => {
                let target = step.triggerScroll.to;
                if (target === "bottom") {
                  target = await page.$eval(step.triggerScroll.selector, (el) => el.scrollHeight - el.clientHeight);
                }
                await smoothScrollElement(page, step.triggerScroll.selector, target || 0, step.triggerScroll.duration || 1000);
              })();
              break;
            }
          }

          if (isCascade) {
            // Snap directly to each element — no bezier curve — so hover states
            // light up in rapid succession without movement overhead.
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await sleep(dwell);
          } else {
            await moveTo(page, box.x + box.width / 2, box.y + box.height / 2);
            await sleep(jitter(dwell));
          }
        }

        // Wait for the triggered scroll to finish before moving to the next step
        if (scrollPromise) await scrollPromise;
      } catch (e) {
        console.warn(
          `   ⚠️  hoverAll failed (${selector}): ${e.message.split("\n")[0]}`,
        );
      }
      break;
    }

    case "hoverContainer": {
      try {
        const el = await page.$(selector);
        if (el) {
          await scrollToElement(page, el);
          const box = await el.boundingBox();
          if (box) {
            await moveTo(page, box.x + box.width / 2, box.y + 20);
            console.log(`   → hoverContainer: ${selector}`);
            await sleep(jitter(dwell));
            if (step.drift !== false) {
              const driftSteps = 8;
              for (let i = 1; i <= driftSteps; i++) {
                const y = box.y + (box.height * i) / driftSteps;
                await moveTo(
                  page,
                  box.x + box.width / 2,
                  Math.min(y, box.y + box.height - 5),
                );
                await sleep(jitter(dwell / driftSteps));
              }
            }
          }
        } else {
          console.warn(`   ⚠️  Not found: ${selector}`);
        }
      } catch (e) {
        console.warn(
          `   ⚠️  hoverContainer failed (${selector}): ${e.message.split("\n")[0]}`,
        );
      }
      break;
    }

    case "click": {
      try {
        const el = await page.$(selector);
        if (el) {
          await scrollToElement(page, el);
          const box = await el.boundingBox();
          if (box)
            await moveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await sleep(jitter(300));
          await el.click({ force: true });
          console.log(`   → click: ${selector}`);
          await sleep(jitter(dwell));
        } else {
          console.warn(`   ⚠️  Not found: ${selector}`);
        }
      } catch (e) {
        console.warn(
          `   ⚠️  click failed (${selector}): ${e.message.split("\n")[0]}`,
        );
      }
      break;
    }

    case "scroll": {
      console.log(`   → scroll to: ${to}px`);
      await smoothScroll(page, to, duration || 1200);
      await sleep(POST_SCROLL);
      break;
    }

    case "scrollElement": {
      let targetScrollTop = to || 0;
      if (to === "bottom") {
        targetScrollTop = await page.$eval(selector, (el) => el.scrollHeight - el.clientHeight);
      }
      console.log(`   → scrollElement: ${selector} to ${targetScrollTop}px`);
      await smoothScrollElement(page, selector, targetScrollTop, duration || 1000);
      break;
    }

    case "scrollToBottom": {
      const pageH = await getPageHeight(page);
      console.log(`   → scroll to bottom (${pageH}px)`);
      await smoothScroll(page, pageH - VIEWPORT.height, duration || 2000);
      await sleep(POST_SCROLL);
      break;
    }

    case "scrollToTop": {
      console.log(`   → scroll to top`);
      await smoothScroll(page, 0, duration || 1800);
      await sleep(800);
      break;
    }

    case "wait": {
      console.log(`   → wait: ${wait || dwell}ms`);
      await sleep(wait || dwell);
      break;
    }

    case "navigate": {
      const linkHandle = await page.evaluateHandle((url) => {
        return (
          [...document.querySelectorAll("a")].find((a) => a.href === url) ||
          null
        );
      }, stepUrl);
      const link = linkHandle.asElement();
      if (link) {
        await scrollToElement(page, link);
        const box = await link.boundingBox();
        if (box)
          await moveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await sleep(jitter(400));
        console.log(`   → navigate (click): ${stepUrl}`);
        await Promise.all([
          page.waitForLoadState("load", { timeout: 20000 }),
          link.click({ force: true }),
        ]);
      } else {
        console.log(`   → navigate (goto): ${stepUrl}`);
        await page.goto(stepUrl, { waitUntil: "load", timeout: 20000 });
      }
      await sleep(1500);
      if (AUTO_DISMISS) await dismissPopups(page);
      await sleep(500);
      break;
    }

    case "parallel": {
      const parallelSteps = step.steps || [];
      console.log(`   → parallel: ${parallelSteps.length} concurrent steps`);
      await Promise.all(parallelSteps.map((s) => runStep(page, s)));
      break;
    }

    case "sequence": {
      const sequenceSteps = step.steps || [];
      console.log(`   → sequence: ${sequenceSteps.length} steps`);
      for (const s of sequenceSteps) {
        await runStep(page, s);
      }
      break;
    }

    case "type": {
      try {
        await page.fill(selector, text || "");
        console.log(`   → type "${text}" into: ${selector}`);
        await sleep(dwell);
      } catch (e) {
        console.warn(
          `   ⚠️  type failed (${selector}): ${e.message.split("\n")[0]}`,
        );
      }
      break;
    }

    case "autoScroll": {
      const height = await getPageHeight(page);
      const stepSize = Math.round(VIEWPORT.height * 0.8);
      const stops = [];
      for (let y = stepSize; y < height - 50; y += stepSize) {
        stops.push(Math.min(y, height - VIEWPORT.height));
      }
      for (const stop of [...new Set(stops)]) {
        await smoothScroll(page, stop, 1100);
        await sleep(POST_SCROLL);
        await autoInteractWithViewport(page);
        await sleep(600);
      }
      await smoothScroll(page, 0, 1800);
      await sleep(1000);
      break;
    }

    default:
      console.warn(`   ⚠️  Unknown step type: ${type}`);
  }
}

// ─── Auto-discovery mode ──────────────────────────────────────────────────────

async function autoInteractWithViewport(page) {
  const interactables = await page.evaluate(() => {
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const SELECTORS = [
      "a",
      "button",
      "input",
      "select",
      "textarea",
      "[tabindex]",
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      "[onclick]",
      "[onmouseenter]",
      "[onmouseover]",
      '[class*="link"]',
      '[class*="btn"]',
      '[class*="button"]',
      '[class*="cta"]',
      '[class*="card"]',
      '[class*="item"]',
      '[class*="nav"]',
      '[class*="menu"]',
      '[class*="hover"]',
      '[class*="trigger"]',
      '[class*="toggle"]',
      "img",
      "li",
    ];
    const seen = new Set();
    const results = [];
    for (const sel of SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (
          r.width < 10 ||
          r.height < 10 ||
          r.top < 0 ||
          r.bottom > viewH ||
          r.left < 0 ||
          r.right > viewW
        )
          continue;
        if (r.width * r.height < 400) continue;
        results.push({
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          sortRow: Math.floor(r.top / 80),
          sortCol: r.left,
          w: Math.round(r.width),
          h: Math.round(r.height),
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.alt || el.placeholder || "")
            .trim()
            .slice(0, 40),
        });
      }
    }
    results.sort((a, b) =>
      a.sortRow !== b.sortRow ? a.sortRow - b.sortRow : a.sortCol - b.sortCol,
    );
    const deduped = [];
    for (const el of results) {
      const tooClose = deduped.some(
        (d) => Math.abs(d.x - el.x) < 60 && Math.abs(d.y - el.y) < 60,
      );
      if (!tooClose) deduped.push(el);
      if (deduped.length >= 8) break;
    }
    return deduped;
  });

  for (const el of interactables) {
    console.log(`   → ${el.tag} "${el.text}" at (${el.x},${el.y})`);
    await moveTo(page, el.x, el.y);
    await sleep(jitter(HOVER_DWELL));
  }
}

async function autoRecordPage(page, label) {
  console.log(`\n📍 Auto-recording: ${label}`);
  await sleep(1500);
  await dismissPopups(page);
  await sleep(800);

  const pageHeight = await getPageHeight(page);
  await autoInteractWithViewport(page);
  await sleep(2000);

  if (pageHeight > VIEWPORT.height + 100) {
    const stepSize = Math.round(VIEWPORT.height * 0.8);
    const stops = [];
    for (let y = stepSize; y < pageHeight - 50; y += stepSize) {
      stops.push(Math.min(y, pageHeight - VIEWPORT.height));
    }
    for (const stop of [...new Set(stops)]) {
      await smoothScroll(page, stop, 1100);
      await sleep(POST_SCROLL);
      await autoInteractWithViewport(page);
      await sleep(800);
    }
    await smoothScroll(page, 0, 1800);
    await sleep(1200);
  }
}

async function autoDiscoverNavLinks(page, baseURL) {
  return await page.evaluate((base) => {
    const selectors = ["nav a", "header a", '[role="navigation"] a'];
    for (const sel of selectors) {
      const links = [...document.querySelectorAll(sel)];
      if (links.length > 1) {
        return links
          .filter((a) => a.offsetParent !== null)
          .map((a) => ({ text: a.innerText.trim(), href: a.href }))
          .filter((a) => {
            if (!a.text || !a.href) return false;
            if (a.href.startsWith("mailto:") || a.href.startsWith("tel:"))
              return false;
            if (a.href === base || a.href === base + "/") return false;
            try {
              return new URL(a.href).hostname === new URL(base).hostname;
            } catch {
              return false;
            }
          })
          .slice(0, 5);
      }
    }
    return [];
  }, baseURL);
}

// ─── FFmpeg ───────────────────────────────────────────────────────────────────

function convertToMp4(webmPath, mp4Path) {
  console.log(`\n🎞  Converting to mp4...`);
  const candidates = [
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    `${process.env.HOME}/Library/Caches/ms-playwright/ffmpeg-1011/ffmpeg-mac-arm64`,
  ];
  for (const ff of candidates) {
    try {
      execSync(
        `"${ff}" -y -i "${webmPath}" -c:v libx264 -crf 18 -preset slow "${mp4Path}"`,
        { stdio: "inherit" },
      );
      console.log(`✅ mp4 saved: ${mp4Path}`);
      return;
    } catch {}
  }
  console.warn(`⚠️  ffmpeg not found. Run: brew install ffmpeg`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const webmOutput = `${OUTPUT}.webm`;
  const mp4Output = `${OUTPUT}.mp4`;
  const outputDir = path.dirname(webmOutput);
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: outputDir, size: VIEWPORT },
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();
  console.log(`\n🎬 Recording: ${URL}`);

  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
  await sleep(1500);
  if (AUTO_DISMISS) await dismissPopups(page);
  await sleep(500);

  if (STEPS && STEPS.length > 0) {
    console.log(`\n▶️  Running ${STEPS.length} configured steps...\n`);
    for (const step of STEPS) {
      await runStep(page, step);
    }
  } else {
    await autoRecordPage(page, URL);
    const navLinks = await autoDiscoverNavLinks(page, URL);
    console.log(`\n📍 Found ${navLinks.length} internal nav links`);
    for (const link of navLinks) {
      try {
        await page.goto(link.href, { waitUntil: "load", timeout: 20000 });
        await autoRecordPage(page, link.text);
      } catch (err) {
        console.warn(
          `   ⚠️  Skipped ${link.href}: ${err.message.split("\n")[0]}`,
        );
      }
    }
  }

  console.log("\n✅ Done recording. Saving...");
  await context.close();
  await browser.close();

  const files = fs
    .readdirSync(outputDir)
    .filter((f) => f.endsWith(".webm") && path.join(outputDir, f) !== webmOutput);
  if (files.length) {
    fs.renameSync(path.join(outputDir, files[0]), webmOutput);
    console.log(`✅ webm saved: ${webmOutput}`);
  } else {
    console.log("⚠️  No .webm file found");
    process.exit(1);
  }

  convertToMp4(webmOutput, mp4Output);

  console.log(
    `\n🎉 All done!\n   webm → ${webmOutput}\n   mp4  → ${mp4Output}`,
  );
})();
