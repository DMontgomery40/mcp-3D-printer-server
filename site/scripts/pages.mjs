// Page map for the documentation site.
//
// Every page is generated from the repository's own Markdown at build time, so
// README.md and docs/*.md stay the single source of truth. Sources select a
// whole file, the README preamble, or a heading (the heading plus everything
// until the next heading of the same or higher level).
//
// When a README section is renamed or added, the sync script still publishes it
// (unmapped level-2 sections get their own page under "More") and prints a
// warning. Update this map to give the section a proper home.

export const PAGES = [
  {
    group: 'Start',
    route: 'guide/index',
    title: 'Overview',
    description: 'What mcp-3d-printer-server does, which printers it supports, and where to start.',
    sources: [
      { file: 'README.md', preamble: true },
      { file: 'README.md', heading: 'Start here' },
      { file: 'README.md', heading: 'Description' },
      { file: 'README.md', heading: 'FULU and open-source printing' },
      { file: 'README.md', heading: "What's new" },
    ],
  },
  {
    group: 'Start',
    route: 'guide/agent-setup',
    title: 'Set up with your agent',
    description: 'A copy-and-paste request that has your agent install and configure the MCP server for your printer.',
    sources: [{ file: 'README.md', heading: 'Set up with your agent' }],
  },
  {
    group: 'Start',
    route: 'guide/examples',
    title: 'What to ask',
    description: 'Ask for the result you want: from a link, a photo, or a message about any of your printers.',
    sources: [{ file: 'README.md', heading: 'What to ask your agent' }],
  },
  {
    group: 'Start',
    route: 'guide/setup',
    title: 'Installation and configuration',
    description: 'Installation, printer backends and credentials, environment variables, MCP client configuration, Docker, and HTTP.',
    sources: [{ file: 'docs/SETUP.md', whole: true }],
  },
  {
    group: 'Guides',
    route: 'guide/slicing',
    title: 'Slicing',
    description: 'GUI export versus CLI slicing, slicer types and profiles, Bambu machine presets, and troubleshooting.',
    sources: [{ file: 'docs/SLICING.md', whole: true }],
  },
  {
    group: 'Guides',
    route: 'guide/fulu',
    title: 'FULU OrcaSlicer-bambulab',
    description: 'Open-source slicing for Bambu Lab projects, FULU runtime setup, and the optional BambuNetwork bridge.',
    sources: [{ file: 'docs/FULU.md', whole: true }],
  },
  {
    group: 'Guides',
    route: 'guide/blender',
    title: 'Blender MCP',
    description: 'Model and refit parts in Blender through your agent, export verified STLs, and a worked phone-case example.',
    sources: [{ file: 'docs/BLENDER.md', whole: true }],
  },
  {
    group: 'Reference',
    route: 'reference/features',
    title: 'Features',
    description: 'Everything the server can do, in one list.',
    sources: [{ file: 'README.md', heading: 'Features' }],
  },
  {
    group: 'Reference',
    route: 'reference/printer-tools',
    title: 'Printer control tools',
    description: 'Status, files, upload, start, cancel, and temperatures across every printer backend, with example arguments.',
    toolGroup: 'Printer control',
    sources: [{ file: 'README.md', heading: 'Printer Control Tools' }],
  },
  {
    group: 'Reference',
    route: 'reference/bambu-tools',
    title: 'Bambu Lab tools',
    description: 'Print sliced 3MF projects on Bambu Lab printers, and inspect the FULU runtime and bridge.',
    toolGroup: 'Bambu Lab',
    sources: [{ file: 'README.md', heading: 'Bambu-Specific Tools' }],
  },
  {
    group: 'Reference',
    route: 'reference/slicing-tools',
    title: 'Slicing tools',
    description: 'Slice models, check G-code temperatures, and run the process-and-print pipeline.',
    toolGroup: 'Slicing',
    sources: [{ file: 'README.md', heading: 'Slicing Tools' }],
  },
  {
    group: 'Reference',
    route: 'reference/stl-tools',
    title: 'STL tools',
    description: 'Inspect, scale, rotate, move, and repair STL meshes before slicing.',
    toolGroup: 'STL editing',
    sources: [{ file: 'README.md', heading: 'STL Manipulation Tools' }],
  },
  {
    group: 'Reference',
    route: 'reference/blender',
    title: 'Blender MCP',
    description: 'Drive a standard Blender MCP server for model edits, with verified STL output.',
    toolGroup: 'Blender',
    sources: [{ file: 'README.md', heading: 'Advanced Tools' }],
  },
  {
    group: 'Reference',
    route: 'reference/resources',
    title: 'MCP resources',
    description: 'Printer status, files, and file details as MCP resources.',
    sources: [{ file: 'README.md', heading: 'Available Resources' }],
  },
  {
    group: 'Reference',
    route: 'reference/limitations',
    title: 'Limitations',
    description: 'Backend, network, memory, and performance limits to know before you print.',
    sources: [
      { file: 'README.md', heading: 'Printer Limitations' },
      { file: 'README.md', heading: 'General Limitations and Considerations' },
    ],
  },
  {
    group: 'Reference',
    route: 'reference/safety',
    title: 'Safety notes',
    description: 'Prompt injection, executable settings, and other precautions for an agent that controls hardware.',
    sources: [{ file: 'README.md', heading: 'MCP Safety Notes' }],
  },
  {
    group: 'Project',
    route: 'project/changelog',
    title: 'Changelog',
    description: 'Versioned changes to mcp-3d-printer-server.',
    sources: [{ file: 'CHANGELOG.md', whole: true }],
  },
  {
    group: 'Project',
    route: 'project/contributors',
    title: 'Contributors',
    description: 'The people whose code, testing, and reports shaped this project.',
    sources: [{ file: 'CONTRIBUTORS.md', whole: true }],
  },
  {
    group: 'Project',
    route: 'project/license',
    title: 'License and thanks',
    description: 'GPL-2.0 license and acknowledgements.',
    sources: [
      { file: 'README.md', heading: 'License' },
      { file: 'README.md', heading: 'Acknowledgements' },
    ],
  },
];

// README content that is intentionally not published as page content.
// "Table of Contents" duplicates the site navigation. "Available Tools" only
// wraps the tool sections, which have their own pages.
export const README_SKIP_SECTIONS = ['Table of Contents'];
export const README_CONTAINER_SECTIONS = ['Available Tools'];

export const SIDEBAR_GROUPS = ['Start', 'Guides', 'Reference', 'Project', 'More'];
