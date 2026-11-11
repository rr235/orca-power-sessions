// Draws the screenshots of the plugin page in assets/plugin-page/, from the panel captures in
// assets/screenshots/. Orca takes a screenshot of at least 1280×800 and a panel capture is narrower,
// so each page shows its captures at twice their size on a 1600×1000 page in their colour scheme.
// Run `bun scripts/plugin-page.ts` after replacing a capture or changing PAGES. Needs Google Chrome.
// The manifest's `screenshots` names these files, with the alt text and caption of each.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Scheme = 'light' | 'dark'
/** A panel capture; `height` keeps only its top part, in the capture's own pixels. */
type Capture = { file: string; height?: number }

/** Page name -> its colour scheme and the captures on it, left to right. */
const PAGES: Record<string, { scheme: Scheme; captures: Capture[] }> = {
  '1-sessions': { scheme: 'dark', captures: [{ file: 'sessions-dark.png', height: 470 }] },
  '2-session-details': { scheme: 'light', captures: [{ file: 'session-details-prs-light.png' }] },
  '3-status-and-warnings': {
    scheme: 'dark',
    captures: [{ file: 'session-details-active-dark.png' }, { file: 'session-details-fable-dark.png' }]
  },
  '4-compact': { scheme: 'light', captures: [{ file: 'compact-light.png' }] },
  '5-quick-actions': { scheme: 'dark', captures: [{ file: 'quick-actions-list-dark.png' }] },
  '6-add-action': { scheme: 'light', captures: [{ file: 'add-action-light.png' }] }
}

/** The page behind the captures, and the line around each one. */
const COLORS: Record<Scheme, { page: string; line: string; shadow: string }> = {
  light: { page: '#ecece9', line: 'rgba(16, 18, 27, 0.08)', shadow: 'rgba(16, 18, 27, 0.18)' },
  dark: { page: '#0b0b0c', line: 'rgba(255, 255, 255, 0.12)', shadow: 'rgba(0, 0, 0, 0.6)' }
}

const WIDTH = 1600
const HEIGHT = 1000
// A capture is in CSS pixels; twice that fills the page and stays sharp when Orca shows it smaller.
const SCALE = 2
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const root = join(import.meta.dir, '..')
const captures = join(root, 'assets', 'screenshots')
const out = join(root, 'assets', 'plugin-page')
const work = mkdtempSync(join(tmpdir(), 'plugin-page-'))

try {
  mkdirSync(out, { recursive: true })
  // Render every page before touching the previous outputs, so a Chrome failure preserves them.
  for (const [name, { scheme, captures: shown }] of Object.entries(PAGES)) {
    const { page, line, shadow } = COLORS[scheme]
    const frames = shown
      .map(({ file, height }) => {
        const clip = height ? ` style="height:${height * SCALE}px"` : ''
        return `<div class="frame"${clip}><img src="file://${join(captures, file)}"></div>`
      })
      .join('')
    const html = join(work, `${name}.html`)
    writeFileSync(
      html,
      `<!doctype html><style>
        * { box-sizing: border-box; margin: 0; }
        html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
        body { background: ${page}; display: flex; align-items: center; justify-content: center; }
        /* Captures of different heights share a top edge. */
        .row { display: flex; align-items: flex-start; gap: 56px; }
        .frame { overflow: hidden; border-radius: 28px; outline: 1px solid ${line}; box-shadow: 0 12px 48px ${shadow}; }
        .frame img { display: block; zoom: ${SCALE}; }
      </style><div class="row">${frames}</div>`
    )
    execFileSync(
      CHROME,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${WIDTH},${HEIGHT}`,
        `--screenshot=${join(work, `${name}.png`)}`,
        `file://${html}`
      ],
      { stdio: 'ignore' }
    )
  }
  const rendered = Object.keys(PAGES).map((name) => ({ name, png: readFileSync(join(work, `${name}.png`)) }))
  for (const { name, png } of rendered) {
    writeFileSync(join(out, `${name}.png`), png)
    console.log(`${name}  (${PAGES[name].scheme}: ${PAGES[name].captures.map(({ file }) => file).join(', ')})`)
  }
  // Remove stale pages only after all replacements are ready.
  for (const file of readdirSync(out).filter((name) => name.endsWith('.png') && !PAGES[name.slice(0, -4)])) {
    rmSync(join(out, file))
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
