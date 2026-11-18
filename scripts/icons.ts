// Draws the panel's Lucide icons as PNGs in assets/details/, one per colour scheme: panel images
// must be plugin PNGs, and a PNG keeps the colour it was drawn in. Run `bun scripts/icons.ts` after
// changing ICONS or COLORS. Needs Google Chrome, which draws the SVGs. Lucide is installed in a
// temporary folder for the run: a plugin folder holds at most 2000 files and no node_modules.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Tone = 'muted' | 'button' | 'success' | 'warning' | 'danger'

/** Asset name -> Lucide icon name (lucide.dev/icons) and colour; `button` draws a solid IconButton around it. */
const ICONS: Record<string, { icon: string; tone: Tone }> = {
  worktree: { icon: 'folder', tone: 'muted' },
  branch: { icon: 'git-branch', tone: 'muted' },
  project: { icon: 'zap', tone: 'muted' },
  'status-waiting': { icon: 'circle-pause', tone: 'warning' },
  'status-failed': { icon: 'circle-x', tone: 'danger' },
  'status-stopped': { icon: 'circle-slash', tone: 'muted' },
  'open-external': { icon: 'external-link', tone: 'muted' },
  pin: { icon: 'pin', tone: 'muted' },
  unpin: { icon: 'pin-off', tone: 'muted' },
  'chat-tab': { icon: 'message-square', tone: 'button' }
}

/** Each colour per Orca colour scheme; `muted` is close to Orca's muted text. */
const COLORS: Record<Tone, { light: string; dark: string }> = {
  muted: { light: '#6b6b76', dark: '#9a9aa2' },
  button: { light: '#212121', dark: '#a9b1d6' },
  success: { light: '#16a34a', dark: '#4ade80' },
  warning: { light: '#d97706', dark: '#fbbf24' },
  danger: { light: '#dc2626', dark: '#f87171' }
}

// The fill of Orca's solid xs IconButton, a 24px square with 6px corners around a 12px glyph.
const BUTTON_FILL = { light: '#f5f5f5', dark: '#3b3e52' }

// Drawn at 64px so they stay sharp at the panel's 12px.
const SIZE = 64
const LUCIDE = 'lucide-static@1.70.0'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const root = join(import.meta.dir, '..')
const out = join(root, 'assets', 'details')
const work = mkdtempSync(join(tmpdir(), 'lucide-'))
const lucide = join(work, 'node_modules', 'lucide-static')

try {
  writeFileSync(join(work, 'package.json'), '{"private":true}')
  execFileSync('bun', ['add', LUCIDE], { cwd: work, stdio: 'ignore' })
  // Keep the previous icons until every replacement has rendered successfully.
  for (const [asset, { icon, tone }] of Object.entries(ICONS)) {
    const svg = readFileSync(join(lucide, 'icons', `${icon}.svg`), 'utf8')
      .replace(/<!--[\s\S]*?-->/, '')
      .replace(/width="24"/, `width="${SIZE}"`)
      .replace(/height="24"/, `height="${SIZE}"`)
    for (const [scheme, color] of Object.entries(COLORS[tone])) {
      const page = join(work, `${asset}-${scheme}.html`)
      const glyph = svg.replace('stroke="currentColor"', `stroke="${color}"`)
      const body =
        tone === 'button'
          ? `<div style="width:${SIZE}px;height:${SIZE}px;border-radius:${SIZE / 4}px;background:${BUTTON_FILL[scheme as 'light' | 'dark']};display:flex;align-items:center;justify-content:center">${glyph.replace(`width="${SIZE}"`, `width="${SIZE / 2}"`).replace(`height="${SIZE}"`, `height="${SIZE / 2}"`)}</div>`
          : glyph
      writeFileSync(page, `<!doctype html><body style="margin:0;background:transparent">${body}</body>`)
      execFileSync(
        CHROME,
        [
          '--headless',
          '--disable-gpu',
          '--hide-scrollbars',
          '--default-background-color=00000000',
          `--window-size=${SIZE},${SIZE}`,
          `--screenshot=${join(work, `${asset}-${scheme}.png`)}`,
          `file://${page}`
        ],
        { stdio: 'ignore' }
      )
    }
    console.log(`${asset}  (${icon}, ${tone})`)
  }
  // Read every expected file before changing any output; Chrome can exit without writing an image.
  const rendered = Object.entries(ICONS).flatMap(([asset, { tone }]) =>
    Object.keys(COLORS[tone]).map((scheme) => {
      const name = `${asset}-${scheme}.png`
      return { name, png: readFileSync(join(work, name)) }
    })
  )
  for (const { name, png } of rendered) {
    writeFileSync(join(out, name), png)
  }
  // Remove icons taken out of ICONS only after all replacements are ready.
  for (const file of readdirSync(out).filter((name) => name.endsWith('.png') && !rendered.some((image) => image.name === name))) {
    rmSync(join(out, file))
  }
  // ISC asks that the notice travel with copies of the icons.
  copyFileSync(join(lucide, 'LICENSE'), join(out, 'LICENSE'))
} finally {
  rmSync(work, { recursive: true, force: true })
}
