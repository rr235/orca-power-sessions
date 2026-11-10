// Runs the `orca` CLI as the same user. The worker starts under the Orca app, without the login
// shell's PATH, so the CLI is tried at its usual install location too.
import { execFile } from 'node:child_process'
import process from 'node:process'

// On Linux, `orca` is usually the GNOME screen reader, so Orca's CLI is `orca-ide` there.
const ORCA_CLI = process.env.ORCA_CLI_COMMAND
  ? [process.env.ORCA_CLI_COMMAND]
  : process.platform === 'linux'
    ? ['orca-ide']
    : ['orca', '/Applications/Orca.app/Contents/Resources/bin/orca']

// sqlite3 reads Orca's session store, for chat sessions' model and effort; macOS ships it. gh reads
// pull request titles, from Homebrew's install location when it is not on PATH.
const CANDIDATES = {
  orca: ORCA_CLI,
  sqlite3: ['sqlite3', '/usr/bin/sqlite3'],
  gh: ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
} as const

const DEFAULT_TIMEOUT_MS = 15000

export type Tool = keyof typeof CANDIDATES

function exec(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        const notFound = (error as { code?: string }).code === 'ENOENT'
        reject(Object.assign(new Error(stderr.trim() || error.message), { notFound }))
        return
      }
      resolve(stdout)
    })
  })
}

/** stdout of `tool args`, from the first install location that exists. */
export async function run(tool: Tool, args: string[], timeout = DEFAULT_TIMEOUT_MS): Promise<string> {
  let lastError: unknown = new Error(`${tool} was not found`)
  for (const file of CANDIDATES[tool]) {
    try {
      return await exec(file, args, timeout)
    } catch (error) {
      lastError = error
      if (!(error as { notFound?: boolean }).notFound) {
        throw error
      }
    }
  }
  throw lastError
}
