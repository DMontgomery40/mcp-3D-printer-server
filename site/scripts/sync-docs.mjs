#!/usr/bin/env node
// Generates the documentation site's Markdown from the repository's README.md,
// docs/*.md, CHANGELOG.md, and CONTRIBUTORS.md. Output goes to site/content/
// and site/.vitepress/generated/, both ignored by Git. Never edit the output;
// edit the source Markdown or site/scripts/pages.mjs instead.
//
// The script fails when a mapped heading is missing, a link or anchor cannot
// be resolved, or README content would be dropped without a page.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import {
  PAGES,
  README_CONTAINER_SECTIONS,
  README_SKIP_SECTIONS,
  SIDEBAR_GROUPS,
} from './pages.mjs';

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(SITE_DIR, '..');
const CONTENT_DIR = path.join(SITE_DIR, 'content');
const GENERATED_DIR = path.join(SITE_DIR, '.vitepress', 'generated');
const REPO_SLUG = 'DMontgomery40/mcp-3D-printer-server';
const REPO_URL = `https://github.com/${REPO_SLUG}`;
const BLOB_PREFIX = `${REPO_URL}/blob/main/`;
const TREE_PREFIX = `${REPO_URL}/tree/main/`;
const README = 'README.md';

const errors = [];
const warnings = [];
const error = (message) => errors.push(message);
const warn = (message) => warnings.push(message);

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const DETAILS_RE = /^\s*(<details>|<\/details>|<summary>.*<\/summary>)\s*$/;
const BADGE_RE = /^\s*\[!\[/;
const DOC_NAV_RE = /^\s*\[Back to README\]/;
const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
// The README's pointer to this site is redundant on the site itself.
const SITE_LINK_RE = /\]\(https:\/\/dmontgomery40\.github\.io\/mcp-3D-printer-server\/?\)/;
const REPO_RE = REPO_SLUG.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// GitHub treats repository names case-insensitively in URLs; accept any casing.
const BLOB_RE = new RegExp(`^https://github\\.com/${REPO_RE}/blob/main/([^#?]+)(?:#(.*))?$`, 'i');
const RAW_RE = new RegExp(`^https://raw\\.githubusercontent\\.com/${REPO_RE}/main/(docs/images/[^?#]+)$`, 'i');

function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = null;
  lines.forEach((line, i) => {
    const match = FENCE_RE.exec(line);
    if (open) {
      mask[i] = true;
      if (match && match[1][0] === open[0] && match[1].length >= open.length && line.trim() === match[1]) {
        open = null;
      }
    } else if (match) {
      open = match[1];
      mask[i] = true;
    }
  });
  if (open) error('Unclosed code fence found while parsing Markdown.');
  return mask;
}

/** Text as GitHub renders it for heading anchors. */
function plainText(markdown) {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*~]/g, '')
    .trim();
}

function parseMarkdown(file) {
  const absolute = path.join(REPO_DIR, file);
  if (!fs.existsSync(absolute)) {
    error(`${file} does not exist.`);
    return null;
  }
  const lines = fs.readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const fence = fenceMask(lines);
  const slugger = new GithubSlugger();
  const headings = [];
  const anchors = [];
  lines.forEach((line, i) => {
    if (fence[i]) return;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const text = heading[2];
      headings.push({ level: heading[1].length, text, plain: plainText(text), line: i, slug: slugger.slug(plainText(text)) });
    }
    for (const anchor of line.matchAll(/<a\s+id="([^"]+)"\s*>\s*<\/a>/g)) {
      anchors.push({ id: anchor[1], line: i });
    }
  });
  return { file, lines, fence, headings, anchors, consumed: new Array(lines.length).fill(false) };
}

function sectionRange(doc, headingText) {
  const matches = doc.headings.filter((h) => h.plain === headingText);
  if (matches.length === 0) return null;
  if (matches.length > 1) warn(`${doc.file}: heading "${headingText}" appears more than once; using the first.`);
  const heading = matches[0];
  const next = doc.headings.find((h) => h.line > heading.line && h.level <= heading.level);
  return { start: heading.line, end: next ? next.line : doc.lines.length, heading };
}

function isTrivialLine(line) {
  return line.trim() === '' || DETAILS_RE.test(line) || /^\s*---\s*$/.test(line);
}

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

const docs = new Map();
function getDoc(file) {
  if (!docs.has(file)) docs.set(file, parseMarkdown(file));
  return docs.get(file);
}

function routeToLink(route) {
  return route.endsWith('/index') ? `/${route.slice(0, -'index'.length)}` : `/${route}`;
}

/**
 * Copies lines from a source range into a page, shifting heading levels and
 * recording which source headings and anchors end up on the page.
 */
function appendRange(page, doc, range, options) {
  const { shift = 0, preamble = false } = options;
  for (let i = range.start; i < range.end; i += 1) {
    const line = doc.lines[i];
    doc.consumed[i] = true;
    if (doc.fence[i]) {
      page.lines.push({ text: line, file: doc.file, fenced: true });
      continue;
    }
    if (DETAILS_RE.test(line) || DOC_NAV_RE.test(line)) continue;
    if (preamble && (BADGE_RE.test(line) || SITE_LINK_RE.test(line) || /^#\s/.test(line))) continue;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const source = doc.headings.find((h) => h.line === i);
      const level = Math.min(6, Math.max(1, heading[1].length + shift));
      const text = TOOL_NAME_RE.test(source.plain) ? `\`${source.plain}\`` : heading[2];
      page.headings.push({ file: doc.file, sourceSlug: source.slug, plain: plainText(text), level });
      page.lines.push({ text: `${'#'.repeat(level)} ${text}`, file: doc.file, heading: true });
      continue;
    }
    for (const anchor of doc.anchors.filter((a) => a.line === i)) {
      page.anchors.push({ file: doc.file, id: anchor.id });
    }
    page.lines.push({ text: line, file: doc.file });
  }
}

function buildPage(definition) {
  const page = {
    ...definition,
    link: routeToLink(definition.route),
    lines: [],
    headings: [],
    anchors: [],
    sourceFile: definition.sources[0].file,
  };
  const combined = definition.sources.length > 1 || definition.sources.some((s) => s.preamble);
  if (combined) {
    page.headings.push({ generated: true, plain: definition.title, level: 1 });
    page.lines.push({ text: `# ${definition.title}`, heading: true }, { text: '' });
  }
  for (const source of definition.sources) {
    const doc = getDoc(source.file);
    if (!doc) continue;
    if (source.whole) {
      appendRange(page, doc, { start: 0, end: doc.lines.length }, {});
    } else if (source.preamble) {
      const firstSection = doc.headings.find((h) => h.level === 2);
      appendRange(page, doc, { start: 0, end: firstSection ? firstSection.line : doc.lines.length }, { preamble: true });
    } else {
      const range = sectionRange(doc, source.heading);
      if (!range) {
        error(`${source.file}: heading "${source.heading}" was not found. Update site/scripts/pages.mjs for page "${definition.title}".`);
        continue;
      }
      const target = combined ? 2 : 1;
      appendRange(page, doc, range, { shift: target - range.heading.level });
    }
    page.lines.push({ text: '' });
  }
  return page;
}

const pages = PAGES.map(buildPage);

// README coverage: publish unmapped sections under "More" and fail on any
// other README content that no page includes.
const readme = getDoc(README);
if (readme) {
  const mappedHeadings = new Set(
    PAGES.flatMap((p) => p.sources.filter((s) => s.file === README && s.heading).map((s) => s.heading)),
  );
  for (const name of [...README_SKIP_SECTIONS, ...README_CONTAINER_SECTIONS]) {
    const range = sectionRange(readme, name);
    if (!range) {
      warn(`README heading "${name}" listed in pages.mjs no longer exists.`);
      continue;
    }
    if (README_SKIP_SECTIONS.includes(name)) {
      for (let i = range.start; i < range.end; i += 1) readme.consumed[i] = true;
    } else {
      readme.consumed[range.start] = true;
    }
  }
  const containerLevels = README_CONTAINER_SECTIONS.map((name) => sectionRange(readme, name)).filter(Boolean);
  const orphanHeadings = readme.headings.filter((h) => {
    if (mappedHeadings.has(h.plain) || README_SKIP_SECTIONS.includes(h.plain) || README_CONTAINER_SECTIONS.includes(h.plain)) return false;
    if (h.level === 2) return true;
    return containerLevels.some((c) => h.line > c.start && h.line < c.end && h.level === c.heading.level + 1);
  });
  for (const heading of orphanHeadings) {
    warn(`README section "${heading.plain}" is not mapped in site/scripts/pages.mjs; publishing it under "More".`);
    const definition = {
      group: 'More',
      route: `more/${heading.slug}`,
      title: heading.plain,
      description: `${heading.plain} (from the README).`,
      sources: [{ file: README, heading: heading.plain }],
    };
    PAGES.push(definition);
    pages.push(buildPage(definition));
  }
  const dropped = [];
  readme.lines.forEach((line, i) => {
    if (!readme.consumed[i] && !isTrivialLine(line)) dropped.push(`${i + 1}: ${line.slice(0, 80)}`);
  });
  if (dropped.length) {
    error(`README content is not published on any page. Map its section in site/scripts/pages.mjs:\n    ${dropped.join('\n    ')}`);
  }
}

// ---------------------------------------------------------------------------
// Anchors and link rewriting
// ---------------------------------------------------------------------------

const fileLinks = new Map(); // repo path -> page link for the file's start
const anchorLinks = new Map(); // `${file}#${id}` -> page link with hash

for (const page of pages) {
  const slugger = new GithubSlugger();
  page.headings.forEach((heading, index) => {
    heading.localSlug = slugger.slug(heading.plain);
    if (heading.generated) return;
    const target = index === 0 ? page.link : `${page.link}#${heading.localSlug}`;
    const key = `${heading.file}#${heading.sourceSlug}`;
    if (!anchorLinks.has(key)) anchorLinks.set(key, target);
  });
  for (const anchor of page.anchors) {
    anchorLinks.set(`${anchor.file}#${anchor.id}`, `${page.link}#${anchor.id}`);
  }
  for (const source of page.sources) {
    if (source.whole || source.preamble) fileLinks.set(source.file, page.link);
  }
}

const imageAssets = new Map(); // repo path -> content-relative path

function assetFor(repoPath) {
  if (!fs.existsSync(path.join(REPO_DIR, repoPath))) {
    error(`Image ${repoPath} does not exist.`);
    return null;
  }
  const relative = `assets/${repoPath.replace(/^docs\//, '')}`;
  imageAssets.set(repoPath, relative);
  return relative;
}

function internalLink(repoPath, hash, context) {
  if (!fileLinks.has(repoPath)) return null;
  if (!hash) return fileLinks.get(repoPath);
  const key = `${repoPath}#${hash}`;
  const target = anchorLinks.get(key) ?? anchorLinks.get(key.toLowerCase());
  if (!target) {
    error(`${context}: link to ${repoPath}#${hash} does not match any heading or anchor.`);
    return `${fileLinks.get(repoPath)}#${hash}`;
  }
  return target;
}

function resolveUrl(url, page, sourceFile, isImage) {
  const context = `${sourceFile} (page ${page.link})`;
  if (url.startsWith('#')) {
    return internalLink(sourceFile, url.slice(1), context) ?? url;
  }
  const blob = url.match(BLOB_RE);
  if (blob) return internalLink(blob[1], blob[2], context) ?? url;
  const raw = url.match(RAW_RE);
  if (raw) {
    const asset = assetFor(raw[1]);
    return asset ? relativeFromPage(page, asset) : url;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return url;

  const [target, hash] = url.split('#');
  const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), target));
  if (repoPath.startsWith('..')) {
    error(`${context}: relative link ${url} points outside the repository.`);
    return url;
  }
  if (isImage || /\.(png|jpe?g|gif|svg|webp)$/i.test(repoPath)) {
    const asset = assetFor(repoPath);
    return asset ? relativeFromPage(page, asset) : url;
  }
  const internal = internalLink(repoPath, hash, context);
  if (internal) return internal;
  const absolute = path.join(REPO_DIR, repoPath);
  if (!fs.existsSync(absolute)) {
    error(`${context}: relative link ${url} points to a missing file.`);
    return url;
  }
  const prefix = fs.statSync(absolute).isDirectory() ? TREE_PREFIX : BLOB_PREFIX;
  return `${prefix}${repoPath}${hash ? `#${hash}` : ''}`;
}

function relativeFromPage(page, contentRelative) {
  const pageDir = path.posix.dirname(page.route);
  const relative = path.posix.relative(pageDir, contentRelative);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

const KNOWN_TAGS = 'a|img|p|br|div|span|sup|sub|kbd|code|strong|em|b|i|details|summary|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|hr|blockquote|pre|picture|source';
const STRAY_LT_RE = new RegExp(`<(?!\\/?(?:${KNOWN_TAGS})\\b|!--|https?:|mailto:)`, 'gi');

function rewriteLine(text, page, sourceFile) {
  const code = [];
  let working = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (match) => {
    if (match.includes('{{')) error(`${sourceFile}: inline code containing "{{" cannot be rendered by VitePress: ${match}`);
    code.push(match);
    return `\u0000${code.length - 1}\u0000`;
  });
  working = working.replace(
    /(!?)\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^()\s]+)((?:\s+"[^"]*")?)\)/g,
    (match, bang, label, url, title) => `${bang}[${label}](${resolveUrl(url, page, sourceFile, bang === '!')}${title})`,
  );
  working = working.replace(/\b(href|src)="([^"]+)"/g, (match, attribute, url) =>
    `${attribute}="${resolveUrl(url, page, sourceFile, attribute === 'src')}"`,
  );
  working = working.replace(STRAY_LT_RE, '&lt;').replaceAll('{{', '&#123;&#123;');
  return working.replace(/\u0000(\d+)\u0000/g, (match, index) => code[Number(index)]);
}

function renderPage(page) {
  const body = page.lines
    .map((line) => (line.fenced || !line.file ? line.text : rewriteLine(line.text, page, line.file)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    `sourceFile: ${JSON.stringify(page.sourceFile)}`,
    'outline: [2, 3]',
    '---',
  ].join('\n');
  return `${frontmatter}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Home page data
// ---------------------------------------------------------------------------

function firstSentence(markdown) {
  const text = plainText(markdown).replace(/\s+/g, ' ');
  const match = text.match(/^(.+?[.!?])(\s|$)/);
  return match ? match[1] : text;
}

function sectionParagraph(doc, heading) {
  const next = doc.headings.find((h) => h.line > heading.line);
  const end = next ? next.line : doc.lines.length;
  const paragraph = [];
  for (let i = heading.line + 1; i < end; i += 1) {
    const line = doc.lines[i];
    if (doc.fence[i] || DETAILS_RE.test(line)) {
      if (paragraph.length) break;
      continue;
    }
    if (line.trim() === '') {
      if (paragraph.length) break;
      continue;
    }
    if (/^\s*([-*>|]|\d+\.)/.test(line) && !paragraph.length) continue;
    paragraph.push(line.trim());
  }
  return paragraph.join(' ');
}

function sourceToolNames() {
  const source = fs.readFileSync(path.join(REPO_DIR, 'src', 'index.ts'), 'utf8');
  return new Set([...source.matchAll(/^\s*name: "([a-z0-9_]+)",$/gm)].map((m) => m[1]));
}

function buildToolGroups() {
  const known = sourceToolNames();
  const assigned = new Set();
  const groups = PAGES.filter((p) => p.toolGroup).map((definition) => {
    const page = pages.find((p) => p.route === definition.route);
    const range = sectionRange(readme, definition.sources[0].heading);
    return { definition, page, range, tools: [] };
  });
  for (const group of groups) {
    if (!group.range) continue;
    for (const heading of readme.headings) {
      if (heading.line <= group.range.start || heading.line >= group.range.end) continue;
      if (!known.has(heading.plain) || assigned.has(heading.plain)) continue;
      assigned.add(heading.plain);
      group.tools.push({
        name: heading.plain,
        link: anchorLinks.get(`${README}#${heading.slug}`) ?? group.page.link,
        summary: firstSentence(sectionParagraph(readme, heading)),
      });
    }
  }
  // Tools documented inside a section's prose rather than under their own heading.
  for (const group of groups) {
    if (!group.range) continue;
    for (let i = group.range.start; i < group.range.end; i += 1) {
      if (readme.fence[i]) continue;
      for (const match of readme.lines[i].matchAll(/`([a-z0-9_]+)`/g)) {
        const name = match[1];
        if (!known.has(name) || assigned.has(name)) continue;
        const owner = [...readme.headings].reverse().find((h) => h.line <= i);
        assigned.add(name);
        group.tools.push({
          name,
          link: anchorLinks.get(`${README}#${owner.slug}`) ?? group.page.link,
          summary: `Documented under ${owner.plain}.`,
        });
      }
    }
  }
  const undocumented = [...known].filter((name) => !assigned.has(name));
  if (undocumented.length) {
    console.log(`  note: tools not documented in a README tool section: ${undocumented.join(', ')}`);
  }
  return groups.map((group) => ({
    title: group.definition.toolGroup,
    link: group.page.link,
    tools: group.tools,
  }));
}

const MODEL_LABELS = {
  p1s: 'P1S', p1p: 'P1P', x1c: 'X1C', x1e: 'X1E', a1: 'A1', a1mini: 'A1 mini', h2d: 'H2D',
};

// The printer backend table in docs/SETUP.md ("Choose your printer backend") is
// the single source for the home page's backend list. Each row is shaped like
//   | `type` | System | Connection | Credentials | **Tier.** Evidence... |
// and the tier must be one of BACKEND_TIERS. Keep the table and BACKEND_TYPES
// in step whenever a backend or its testing evidence changes.
const BACKEND_TYPES = ['bambu', 'octoprint', 'klipper', 'prusa', 'duet', 'repetier', 'creality'];
const BACKEND_TIERS = { 'Most tested': 'tested', 'Community-reported': 'community', Unverified: 'unverified' };

function buildPrinters() {
  const setup = getDoc('docs/SETUP.md');
  const range = setup && sectionRange(setup, 'Choose your printer backend');
  if (!range) {
    error('docs/SETUP.md: the "Choose your printer backend" section is missing; the home page reads its table.');
    return { backends: [], bambuModels: [] };
  }
  const backends = [];
  for (let i = range.start; i < range.end; i += 1) {
    const row = setup.fence[i] ? null : setup.lines[i].match(/^\|\s*`([a-z]+)`\s*\|(.+)\|\s*$/);
    if (!row) continue;
    const columns = row[2].split('|').map((cell) => cell.trim());
    const tier = columns.at(-1).match(/^\*\*([^*]+?)\.\*\*\s*(.*)$/);
    if (columns.length !== 4 || !tier || !BACKEND_TIERS[tier[1]]) {
      const tiers = Object.keys(BACKEND_TIERS).map((name) => `**${name}.**`).join(', ');
      error(`docs/SETUP.md:${i + 1}: the "${row[1]}" backend row needs five columns, with evidence starting ${tiers}`);
      continue;
    }
    backends.push({
      code: row[1],
      label: plainText(columns[0]),
      tier: BACKEND_TIERS[tier[1]],
      tierLabel: tier[1],
      note: firstSentence(tier[2]),
    });
  }
  const found = backends.map((backend) => backend.code);
  const missing = BACKEND_TYPES.filter((code) => !found.includes(code));
  const extra = found.filter((code) => !BACKEND_TYPES.includes(code));
  if (missing.length || extra.length) {
    error(
      `docs/SETUP.md: backend table mismatch (missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'}). ` +
        'Update the table or BACKEND_TYPES in site/scripts/sync-docs.mjs.',
    );
  }

  const modelRow = setup.lines.find((line) => line.startsWith('| `BAMBU_MODEL` |'));
  const list = modelRow?.match(/Printer model: ((?:`[a-z0-9]+`(?:, )?)+)/);
  if (!list) {
    error('docs/SETUP.md: could not read the Bambu model list from the BAMBU_MODEL row for the home page.');
    return { backends, bambuModels: [] };
  }
  const order = Object.keys(MODEL_LABELS);
  const bambuModels = [...list[1].matchAll(/`([a-z0-9]+)`/g)]
    .map((m) => m[1])
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map((code) => ({ code, label: MODEL_LABELS[code] ?? code.toUpperCase() }));
  return { backends, bambuModels };
}

// Reads the README's "What to ask your agent" examples. Each group is a level-3
// heading with an optional intro paragraph, then bullets shaped like:
//   - **"Prompt text."** *(optional attachment note)*
//     What the agent does with it.
function buildPrompts() {
  const range = sectionRange(readme, 'What to ask your agent');
  if (!range) return [];
  const groups = [];
  let current = null;
  for (let i = range.start + 1; i < range.end; i += 1) {
    const line = readme.lines[i];
    const heading = HEADING_RE.exec(line);
    if (heading) {
      current = { title: plainText(heading[2]), intro: '', prompts: [] };
      groups.push(current);
      continue;
    }
    if (!current || readme.fence[i] || !line.trim()) continue;
    const item = line.match(/^- \*\*"(.+)"\*\*(?:\s+\*\((.+)\)\*)?\\?\s*$/);
    if (item) {
      current.prompts.push({ text: item[1], context: item[2] ?? null, detail: '' });
    } else if (/^\s+\S/.test(line) && current.prompts.length) {
      const prompt = current.prompts.at(-1);
      prompt.detail = `${prompt.detail} ${plainText(line)}`.trim();
    } else if (!current.prompts.length && !/^\s*[-*|>]/.test(line)) {
      current.intro = `${current.intro} ${plainText(line)}`.trim();
    }
  }
  const usable = groups.filter((group) => group.prompts.length);
  if (!usable.length) error('README "What to ask your agent" has no examples in the expected "- **\\"prompt\\"**" format.');
  return usable;
}

function renderHome() {
  const preambleEnd = readme.headings.find((h) => h.level === 2)?.line ?? 0;
  const thanks = [];
  for (let i = 0; i < preambleEnd; i += 1) {
    const line = readme.lines[i];
    if (line.startsWith('>')) thanks.push(line);
    else if (thanks.length) break;
  }
  if (!thanks.length) error('README preamble no longer starts with the thank-you blockquote used on the home page.');

  const setupRange = sectionRange(readme, 'Set up with your agent');
  const setupLines = setupRange ? readme.lines.slice(setupRange.start + 1, setupRange.end) : [];
  const intro = setupLines.find((line) => line.trim() && !readme.fence[setupRange.start + 1 + setupLines.indexOf(line)]);
  const fenceStart = setupLines.findIndex((line, i) => readme.fence[setupRange.start + 1 + i]);
  let fenceEnd = fenceStart;
  while (fenceEnd + 1 < setupLines.length && readme.fence[setupRange.start + 2 + fenceEnd]) fenceEnd += 1;
  if (!intro || fenceStart < 0) error('README "Set up with your agent" no longer has an intro line followed by a code block.');

  const homePage = { route: 'index', link: '/' };
  const rewrite = (line) => rewriteLine(line, homePage, README);
  return [
    '---',
    'layout: home',
    'markdownStyles: false',
    'title: mcp-3d-printer-server',
    `titleTemplate: ${JSON.stringify('MCP server for 3D printers')}`,
    `description: ${JSON.stringify('Send your agent a link, a photo, or a message. An MCP server that lets Claude, Codex, and other agents adapt models, slice, and print on OctoPrint, Klipper, Bambu Lab, Prusa, and other 3D printers.')}`,
    '---',
    '',
    '<HomeHero />',
    '',
    '<section class="home-thanks" aria-label="Thanks and open-source printing">',
    '<div class="home-wrap home-thanks__body">',
    '',
    ...thanks.map(rewrite),
    '',
    '</div>',
    '</section>',
    '',
    '<section id="setup" class="home-section home-setup" aria-labelledby="setup-heading">',
    '<div class="home-wrap home-setup__grid">',
    '<div class="home-setup__intro">',
    '<h2 id="setup-heading" class="home-h2">Set up with your agent</h2>',
    '',
    rewrite(intro ?? ''),
    '',
    '<HomeSetupSteps />',
    '',
    '</div>',
    '<div class="home-setup__prompt vp-doc">',
    '',
    ...(fenceStart >= 0 ? setupLines.slice(fenceStart, fenceEnd + 1) : []),
    '',
    '</div>',
    '</div>',
    '</section>',
    '',
    '<HomePrompts />',
    '',
    '<HomePrintPath />',
    '',
    '<HomeTools />',
    '',
    '<HomePrinters />',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function sidebar() {
  return SIDEBAR_GROUPS.map((group) => ({
    text: group,
    items: pages.filter((p) => p.group === group).map((p) => ({ text: p.title, link: p.link })),
  })).filter((group) => group.items.length);
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function main() {
  const rendered = pages.map((page) => ({ page, markdown: renderPage(page) }));
  const home = readme ? renderHome() : '';
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  const data = {
    version: packageJson.version,
    repository: REPO_URL,
    npm: `https://www.npmjs.com/package/${packageJson.name}`,
    tools: readme ? buildToolGroups() : [],
    printers: buildPrinters(),
    prompts: readme ? buildPrompts() : [],
  };

  for (const message of warnings) console.warn(`  warning: ${message}`);
  if (errors.length) {
    for (const message of errors) console.error(`  error: ${message}`);
    console.error(`\nsync-docs: ${errors.length} error(s). No files were written.`);
    process.exit(1);
  }

  fs.rmSync(CONTENT_DIR, { recursive: true, force: true });
  fs.rmSync(GENERATED_DIR, { recursive: true, force: true });
  for (const { page, markdown } of rendered) write(path.join(CONTENT_DIR, `${page.route}.md`), markdown);
  write(path.join(CONTENT_DIR, 'index.md'), home);
  // VitePress serves static files from <srcDir>/public.
  fs.cpSync(path.join(SITE_DIR, 'public'), path.join(CONTENT_DIR, 'public'), { recursive: true });
  for (const [repoPath, relative] of imageAssets) {
    write(path.join(CONTENT_DIR, relative), fs.readFileSync(path.join(REPO_DIR, repoPath)));
  }
  write(path.join(GENERATED_DIR, 'sidebar.json'), `${JSON.stringify(sidebar(), null, 2)}\n`);
  write(path.join(GENERATED_DIR, 'home.json'), `${JSON.stringify(data, null, 2)}\n`);

  const readmeLines = readme ? readme.lines.filter((line) => !isTrivialLine(line)).length : 0;
  console.log(
    `sync-docs: wrote ${rendered.length} pages and the home page from ${docs.size} source files ` +
      `(${readmeLines} README content lines, all published or intentionally skipped).`,
  );
}

main();
