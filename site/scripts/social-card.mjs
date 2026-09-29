#!/usr/bin/env node
// Renders site/public/social-card.png, the 1200x630 image shown when a link to
// the site is shared on X, Bluesky, Slack, and similar apps. It uses the same
// fonts and toolpath geometry as the home page and renders with headless Chrome.
//
//   npm run social-card            (set CHROME_PATH if Chrome is not in the default location)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VIEWBOX, infill, infillClip, walls } from '../.vitepress/theme/toolpath.mjs';

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(SITE_DIR, 'public', 'social-card.png');
const fontUrl = (pkg, file) =>
  pathToFileURL(path.join(SITE_DIR, 'node_modules', '@fontsource-variable', pkg, 'files', file)).href;

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => fs.existsSync(candidate));
if (!chrome) {
  console.error('social-card: Chrome was not found. Set CHROME_PATH to a Chrome or Chromium executable.');
  process.exit(1);
}

const logo = fs.readFileSync(path.join(SITE_DIR, 'public', 'logo.svg'), 'utf8');

const toolpath = `
<svg viewBox="0 0 ${VIEWBOX.width} ${VIEWBOX.height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M20 0H0V20" fill="none" stroke="var(--tp-grid)" stroke-width="1"/>
    </pattern>
    <clipPath id="infill"><path d="${infillClip}" clip-rule="evenodd"/></clipPath>
  </defs>
  <rect width="${VIEWBOX.width}" height="${VIEWBOX.height}" fill="var(--tp-plate)"/>
  <rect width="${VIEWBOX.width}" height="${VIEWBOX.height}" fill="url(#grid)"/>
  <g clip-path="url(#infill)" stroke="var(--tp-infill)" stroke-width="3.4" fill="none" stroke-linecap="round">
    ${infill.map((line) => `<path d="${line.d}"/>`).join('')}
  </g>
  ${walls
    .map(
      (group) =>
        `<g stroke="${group.color}" stroke-width="4.4" fill="none" stroke-linecap="round" stroke-linejoin="round">${group.paths
          .map((d) => `<path d="${d}"/>`)
          .join('')}</g>`,
    )
    .join('')}
</svg>`;

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: 'Archivo';
    src: url(${fontUrl('archivo', 'archivo-latin-wdth-normal.woff2')}) format('woff2');
    font-weight: 100 900;
    font-stretch: 62% 125%;
  }
  @font-face {
    font-family: 'JetBrains Mono';
    src: url(${fontUrl('jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2')}) format('woff2');
    font-weight: 100 800;
  }
  :root {
    --tp-plate: #1c232b;
    --tp-grid: #28313b;
    --tp-outer: #ff8a3d;
    --tp-inner: #f5ce4a;
    --tp-infill: #e0474c;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    width: 1200px;
    height: 630px;
    overflow: hidden;
    background: #141a21;
    color: #e6eaef;
    font-family: 'Archivo', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .copy {
    position: absolute;
    left: 68px;
    top: 58px;
    width: 580px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 25px;
    font-weight: 720;
    font-stretch: 116%;
    white-space: nowrap;
  }
  .brand svg { width: 34px; height: 34px; }
  .brand span { color: #8390a0; font-weight: 500; font-stretch: 100%; font-size: 21px; margin-left: 6px; }
  h1 {
    margin: 44px 0 0;
    font-size: 70px;
    line-height: 0.98;
    font-stretch: 125%;
    font-weight: 820;
    letter-spacing: -0.035em;
  }
  .chat {
    margin-top: 38px;
    display: grid;
    gap: 12px;
  }
  .bubble {
    max-width: 470px;
    padding: 13px 18px;
    border-radius: 20px;
    font-size: 20px;
    line-height: 1.36;
  }
  .me {
    justify-self: end;
    background: #4cc7bc;
    color: #0d1a1a;
    font-weight: 560;
    border-bottom-right-radius: 6px;
  }
  .agent {
    justify-self: start;
    background: #1f2832;
    border: 1px solid #334050;
    color: #d9dfe6;
    border-bottom-left-radius: 6px;
  }
  .panel {
    position: absolute;
    left: 690px;
    top: 66px;
    width: 540px;
    border-radius: 20px;
    background: #11171d;
    border: 1px solid #2a3440;
    overflow: hidden;
    box-shadow: 0 40px 80px -30px rgba(0, 0, 0, 0.7);
  }
  .bar, .legend {
    display: flex;
    gap: 20px;
    padding: 15px 22px;
    font-size: 17px;
    color: #aab4c0;
  }
  .bar { border-bottom: 1px solid #232c36; }
  .bar .file { font-family: 'JetBrains Mono', monospace; color: #d9dfe6; }
  .legend { border-top: 1px solid #232c36; }
  .legend i {
    display: inline-block;
    width: 20px;
    height: 5px;
    border-radius: 3px;
    margin-right: 9px;
    vertical-align: middle;
  }
  .panel svg { display: block; width: 540px; height: 378px; }
</style>
</head>
<body>
  <div class="copy">
    <div class="brand">${logo}mcp-3d-printer-server<span>for 3D printers</span></div>
    <h1>Print from a<br>conversation.</h1>
    <div class="chat">
      <div class="bubble me">Here's a phone case on MakerWorld. Make it fit my iPhone 17 Pro Max and print it.</div>
      <div class="bubble agent">Refit to Apple's published dimensions and sliced for your Prusa MK4. It's ready. Start the print?</div>
    </div>
  </div>
  <div class="panel">
    <div class="bar"><span class="file">phone_case.gcode</span><span>Layer 1 of 212</span></div>
    ${toolpath}
    <div class="legend">
      <span><i style="background: var(--tp-outer)"></i>Outer wall</span>
      <span><i style="background: var(--tp-inner)"></i>Inner wall</span>
      <span><i style="background: var(--tp-infill)"></i>Sparse infill</span>
    </div>
  </div>
</body>
</html>`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp3d-social-card-'));
const htmlPath = path.join(workDir, 'card.html');
fs.writeFileSync(htmlPath, html);
execFileSync(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1200,630',
    '--virtual-time-budget=4000',
    `--screenshot=${OUTPUT}`,
    pathToFileURL(htmlPath).href,
  ],
  { stdio: 'ignore' },
);
fs.rmSync(workDir, { recursive: true, force: true });
console.log(`social-card: wrote ${path.relative(process.cwd(), OUTPUT)} (${fs.statSync(OUTPUT).size} bytes)`);
