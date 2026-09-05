#!/usr/bin/env node
/**
 * Regenerates docs/demo.gif: the README demo showing a real `fhir-oas`
 * invocation and the resulting spec explored in Swagger UI.
 *
 * Requires dev-only tooling that is intentionally NOT in package.json
 * (this asset is regenerated rarely):
 *
 *   npm install --no-save playwright swagger-ui-dist gifenc pngjs
 *   npm run build && node scripts/make-demo.mjs
 *
 * Chromium comes from Playwright (PLAYWRIGHT_BROWSERS_PATH when preinstalled).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import gifenc from "gifenc";
import { PNG } from "pngjs";
import swaggerUiDist from "swagger-ui-dist";
const { GIFEncoder, quantize, applyPalette } = gifenc;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "demo.gif");
const W = 960;
const H = 600;

const RESOURCES = ["Patient", "CarePlan"];
const OUTFILE = "patient-careplan.yaml";
/** The resource opened up in the Swagger UI scene. */
const FOCUS = "Patient";
const COMMAND =
  `fhir-oas generate ${RESOURCES.join(" ")} --fhir-version r4 -o ${OUTFILE}`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fhir-oas-demo-"));
const specPath = path.join(work, "demo.openapi.json");
const yamlPath = path.join(work, OUTFILE);

// --- 1. Generate the spec for real, and read its real shape -----------------
console.log("Generating spec...");
execFileSync(
  "node",
  [
    path.join(ROOT, "dist/cli.js"),
    "generate",
    ...RESOURCES,
    "--fhir-version",
    "r4",
    "--format",
    "json",
    "-o",
    specPath,
  ],
  { stdio: "pipe" },
);
execFileSync(
  "node",
  [
    path.join(ROOT, "dist/cli.js"),
    "generate",
    ...RESOURCES,
    "--fhir-version",
    "r4",
    "-o",
    yamlPath,
  ],
  { stdio: "pipe" },
);
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const stats = {
  schemas: Object.keys(spec.components.schemas).length,
  paths: Object.keys(spec.paths).length,
  operations: Object.values(spec.paths).reduce(
    (n, item) => n + Object.keys(item).filter((k) => k !== "parameters").length,
    0,
  ),
};
console.log(`  ${stats.schemas} schemas, ${stats.paths} paths, ${stats.operations} operations`);

// --- 2. Terminal scene ------------------------------------------------------
const TERM_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${W}px; height:${H}px; background:#0d1117; display:flex;
         align-items:center; justify-content:center; font-family:ui-sans-serif,system-ui,sans-serif; }
  .win { width:${W - 80}px; background:#161b22; border:1px solid #30363d; border-radius:10px;
         overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,.5); }
  .bar { height:38px; background:#21262d; display:flex; align-items:center; padding:0 14px; gap:8px;
         border-bottom:1px solid #30363d; }
  .dot { width:12px; height:12px; border-radius:50%; }
  .title { color:#8b949e; font-size:12.5px; margin-left:10px; letter-spacing:.2px; }
  pre { padding:22px 24px; color:#c9d1d9; font:14.5px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace;
        white-space:pre; overflow:hidden; min-height:${H - 200}px; }
  .p { color:#58a6ff; font-weight:700; }
  .cmd { color:#e6edf3; }
  .flag { color:#d2a8ff; }
  .ok { color:#3fb950; }
  .dim { color:#8b949e; }
  .cur { background:#58a6ff; color:#58a6ff; border-radius:1px; }
  .k { color:#79c0ff; }
  .s { color:#a5d6ff; }
  .d { color:#8b949e; }
`;

function termHtml(body) {
  return `<style>${TERM_CSS}</style><div class="win">
    <div class="bar"><span class="dot" style="background:#ff5f56"></span>
      <span class="dot" style="background:#ffbd2e"></span>
      <span class="dot" style="background:#27c93f"></span>
      <span class="title">fhir-openapi-translator</span></div>
    <pre>${body}</pre></div>`;
}

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Minimal YAML colouring: keys, quoted strings, list bullets. */
function yamlHtml(text) {
  return esc(text)
    .split("\n")
    .map((line) =>
      line
        .replace(/^(\s*)(- )?([\w./{}$_-]+):/, (_m, indent, dash, key) =>
          `${indent}${dash ? `<span class="d">${dash}</span>` : ""}<span class="k">${key}</span>:`)
        .replace(/^(\s*)- (?![\w./{}$_-]+:)(.*)$/, (_m, indent, rest) =>
          `${indent}<span class="d">- </span>${rest}`)
        .replace(/&quot;[^&]*&quot;/g, (m) => `<span class="s">${m}</span>`),
    )
    .join("\n");
}

const CMD_HTML = COMMAND.replace(/--[a-z-]+/g, (m) => `<span class="flag">${m}</span>`);

const frames = [];
// Set DEMO_FRAME_DIR to also dump each frame as a PNG (for reviewing the demo).
const FRAME_DIR = process.env.DEMO_FRAME_DIR;
if (FRAME_DIR) fs.mkdirSync(FRAME_DIR, { recursive: true });
const push = (buf, delay) => {
  if (FRAME_DIR) {
    fs.writeFileSync(path.join(FRAME_DIR, `f${String(frames.length).padStart(2, "0")}.png`), buf);
  }
  frames.push({ buf, delay });
};

// Use a preinstalled Chromium when present (PLAYWRIGHT_BROWSERS_PATH images
// may ship a different build than the installed playwright expects).
const PREINSTALLED = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(
  fs.existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {},
);
const page = await browser.newPage({ viewport: { width: W, height: H } });

// Capture via CDP: Playwright's screenshot waits for the page to go idle,
// which never happens while Swagger UI renders FHIR's recursive schemas.
const cdp = await page.context().newCDPSession(page);
async function shot() {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  return Buffer.from(data, "base64");
}

console.log("Capturing terminal scene...");
// Type the command out.
const steps = [0, 8, 17, 26, 34, 43, 52, 60, 68, COMMAND.length];
for (const n of steps) {
  const typed = COMMAND.slice(0, n).replace(/--[a-z-]+/g, (m) => `<span class="flag">${m}</span>`);
  await page.setContent(
    termHtml(`<span class="p">$</span> <span class="cmd">${typed}</span><span class="cur">_</span>`),
  );
  push(await shot(), 70);
}
await page.setContent(termHtml(`<span class="p">$</span> <span class="cmd">${CMD_HTML}</span>`));
push(await shot(), 800);

const done = `<span class="p">$</span> <span class="cmd">${CMD_HTML}</span>`;
await page.setContent(termHtml(`${done}\n\n<span class="ok">Wrote ${OUTFILE}</span>`));
push(await shot(), 900);

await page.setContent(
  termHtml(
    `${done}\n\n<span class="ok">Wrote ${OUTFILE}</span>\n` +
      `<span class="dim">  ${RESOURCES.length} resources · ${stats.schemas} schemas · ` +
      `${stats.paths} paths · ${stats.operations} operations</span>\n` +
      `<span class="dim">  OpenAPI 3.0.3 · FHIR R4 (4.0.1) · offline, no server needed</span>`,
  ),
);
push(await shot(), 2100);

// --- 2b. Raw YAML scene: the artifact itself, before any viewer ------------
console.log("Capturing raw YAML scene...");
const yamlText = fs.readFileSync(yamlPath, "utf8");
const yamlLines = yamlText.split("\n");

function shellScene(cmdText, output) {
  const cmd = `<span class="p">$</span> <span class="cmd">${esc(cmdText)}</span>`;
  return output === undefined ? cmd : `${cmd}\n${output}`;
}

// head: the top of the generated document.
const headCmd = `head -14 ${OUTFILE}`;
await page.setContent(termHtml(shellScene(headCmd) + `<span class="cur">_</span>`));
push(await shot(), 500);
await page.setContent(
  termHtml(shellScene(headCmd, yamlHtml(yamlLines.slice(0, 14).join("\n")))),
);
push(await shot(), 2600);

// grep: a required binding rendered as a typed enum, in the raw file.
const grepCmd = `grep -A6 "gender:" ${OUTFILE} | head -7`;
const genderStart = yamlLines.findIndex((l) => /^\s+gender:/.test(l));
const genderBlock = yamlLines.slice(genderStart, genderStart + 7).join("\n");
await page.setContent(termHtml(shellScene(grepCmd) + `<span class="cur">_</span>`));
push(await shot(), 500);
await page.setContent(termHtml(shellScene(grepCmd, yamlHtml(genderBlock))));
push(await shot(), 2800);

// --- 3. Swagger UI scene ----------------------------------------------------
console.log("Capturing Swagger UI scene...");
const distDir = swaggerUiDist.getAbsoluteFSPath();
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/spec.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(fs.readFileSync(specPath));
  }
  if (url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(`<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="/swagger-ui.css">
      <style>body{margin:0}.topbar{display:none}
        .swagger-ui .info{margin:18px 0 14px}
        .swagger-ui .info .title{font-size:30px}
        .swagger-ui .scheme-container{display:none}</style></head>
      <body><div id="ui"></div>
      <script src="/swagger-ui-bundle.js"></script>
      <script>window.ui = SwaggerUIBundle({ url:'/spec.json', dom_id:'#ui',
        docExpansion:'none', defaultModelsExpandDepth:1, defaultModelExpandDepth:1, defaultModelRendering:'model',
        tryItOutEnabled:false, supportedSubmitMethods:[] });</script>
      </body></html>`);
  }
  const file = path.join(distDir, path.basename(url));
  if (fs.existsSync(file)) {
    const type = file.endsWith(".css") ? "text/css" : "application/javascript";
    res.writeHead(200, { "Content-Type": type });
    return res.end(fs.readFileSync(file));
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
await page.waitForSelector(".opblock-tag", { timeout: 30000 });
await page.addStyleTag({ content: "*{scroll-behavior:auto !important}" });
await page.waitForTimeout(900);
push(await shot(), 1700); // overview: the clinical resource tags

// Open one clinical resource and show its generated endpoints.
await page.evaluate((tag) => {
  document.querySelector(`.opblock-tag[data-tag="${tag}"]`)?.scrollIntoView({ block: "start" });
}, FOCUS);
await page.waitForTimeout(400);
push(await shot(), 1000);
await page.click(`.opblock-tag[data-tag="${FOCUS}"]`);
await page.waitForSelector(`#operations-${FOCUS}-read${FOCUS}`, { timeout: 30000 });
await page.evaluate((tag) => {
  document.querySelector(`.opblock-tag[data-tag="${tag}"]`)?.scrollIntoView({ block: "start" });
}, FOCUS);
await page.waitForTimeout(700);
push(await shot(), 1700);
await page.evaluate(() => window.scrollBy(0, 300));
await page.waitForTimeout(420);
push(await shot(), 1500);

// Collapse the tag and open the Schemas (models) section.
await page.click(`.opblock-tag[data-tag="${FOCUS}"]`);
await page.waitForTimeout(400);
await page.click("section.models h4");
// Wait for the schema list to render before reaching into it.
for (const m of RESOURCES) await page.waitForSelector(`#model-${m}`, { timeout: 60000 });
await page.waitForTimeout(800);
await page.evaluate(() => {
  document.querySelector("section.models")?.scrollIntoView({ block: "start" });
});
await page.waitForTimeout(500);
push(await shot(), 1600); // the generated model list

// Expand each generated resource model to show its fields.
for (const model of RESOURCES.slice().sort()) {
  await page.evaluate((m) => {
    document.querySelector(`#model-${m}`)?.scrollIntoView({ block: "start" });
  }, model);
  await page.waitForTimeout(450);
  push(await shot(), 1000);

  await page.click(`#model-${model} .model-toggle, #model-${model} .model-title`);
  await page.waitForTimeout(1300);
  await page.evaluate((m) => {
    document.querySelector(`#model-${m}`)?.scrollIntoView({ block: "start" });
  }, model);
  await page.waitForTimeout(450);
  push(await shot(), 1800);

  for (const dy of [270, 270]) {
    await page.evaluate((y) => window.scrollBy(0, y), dy);
    await page.waitForTimeout(480);
    push(await shot(), 1400);
  }
}
push(await shot(), 2400); // final hold

server.close();
await browser.close();

// --- 4. Encode the GIF ------------------------------------------------------
console.log(`Encoding ${frames.length} frames...`);
const gif = GIFEncoder();
let i = 0;
for (const { buf, delay } of frames) {
  const png = PNG.sync.read(buf);
  const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
  const palette = quantize(rgba, 256, { format: "rgb444" });
  const index = applyPalette(rgba, palette, "rgb444");
  gif.writeFrame(index, png.width, png.height, {
    palette,
    delay,
    ...(i === 0 ? { repeat: 0 } : {}),
  });
  i++;
}
gif.finish();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, gif.bytes());
fs.rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`);
