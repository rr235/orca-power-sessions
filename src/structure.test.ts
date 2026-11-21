// Guards the folder rules in docs/code-structure.md: which files may reach Orca, and
// which may import which. A guard, not a linter: it reads each file's import specifiers and a few
// call names.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { assert, test } from 'orca/testing'

const SRC = decodeURIComponent(new URL('.', import.meta.url).pathname)
const THIS = 'structure.test.ts'

/** Every source file under src/, relative to it, with its text. */
function sources(dir = SRC): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry: { name: string; isDirectory(): boolean }) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      return sources(full)
    }
    return /\.tsx?$/.test(entry.name) ? [{ path: relative(SRC, full), text: readFileSync(full, 'utf8') }] : []
  })
}

/** A file's import specifiers, relative ones resolved to a path under src/. */
function imports(file: { path: string; text: string }): string[] {
  const specifiers = [...file.text.matchAll(/^\s*(?:import|export)\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2])
  return specifiers.map((s) => (s.startsWith('.') ? relative(SRC, resolve(SRC, dirname(file.path), s)).replace(/\.tsx?$/, '') : s))
}

const isTest = (path: string) => /\.(test|check)\.tsx?$/.test(path)
const inFolder = (path: string, folder: string) => path.startsWith(`${folder}/`) || path === folder
const files = sources().filter((f) => f.path !== THIS)

test('only src/orca reaches Orca: its CLI, its databases and its runtime client', () => {
  const reaching = files.filter((f) => !inFolder(f.path, 'orca') && /\brun\(\s*['"](orca|sqlite3)['"]|\brunInOrca\(/.test(f.text))
  assert.deepEqual(reaching.map((f) => f.path), [])
})

test('src/sessions and src/actions never import each other', () => {
  const crossing = files
    .filter((f) => !isTest(f.path))
    .flatMap((f) =>
      imports(f)
        .filter((i) => (inFolder(f.path, 'sessions') && inFolder(i, 'actions')) || (inFolder(f.path, 'actions') && inFolder(i, 'sessions')))
        .map((i) => `${f.path} -> ${i}`)
    )
  assert.deepEqual(crossing, [])
})

test('panel code imports only orca, protocol, shared and itself', () => {
  const allowed = (i: string) => i === 'orca' || i === 'protocol' || i === 'shared' || i === 'panel' || inFolder(i, 'panel')
  const panelFiles = files.filter((f) => !isTest(f.path) && (f.path === 'panel.tsx' || inFolder(f.path, 'panel')))
  assert.ok(panelFiles.length > 1, 'finds the panel files')
  const strays = panelFiles.flatMap((f) => imports(f).filter((i) => !allowed(i)).map((i) => `${f.path} -> ${i}`))
  assert.deepEqual(strays, [])
})

test('shared.ts and protocol.ts import nothing from Node', () => {
  const node = files.filter((f) => f.path === 'shared.ts' || f.path === 'protocol.ts').flatMap((f) => imports(f).filter((i) => i.startsWith('node:')).map((i) => `${f.path} -> ${i}`))
  assert.deepEqual(node, [])
})
