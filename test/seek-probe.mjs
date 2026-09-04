/**
 * Launcher for `seek-probe.cjs`.
 *
 * Same shape as `shots.mjs`: a throwaway package directory whose `main` is the
 * probe, a temporary userData directory so the real library is never touched,
 * and `ELECTRON_RUN_AS_NODE` explicitly deleted because some toolchains export
 * it and it turns the Electron binary into a plain Node one.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const profile = mkdtempSync(join(tmpdir(), 'rebind-capture-probe-'))
mkdirSync(join(profile, 'library'), { recursive: true })

const appDir = mkdtempSync(join(tmpdir(), 'rebind-capture-probe-app-'))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
writeFileSync(join(appDir, 'package.json'), JSON.stringify({
  name: 'rebind-capture-probe',
  version: pkg.version,
  main: join(HERE, 'seek-probe.cjs')
}, null, 2))

const env = { ...process.env, REBIND_PROBE_OUT: join(ROOT, 'shots') }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(require('electron'), [appDir, `--user-data-dir=${profile}`], {
  stdio: 'inherit', env
})

child.on('exit', (code) => {
  rmSync(profile, { recursive: true, force: true })
  rmSync(appDir, { recursive: true, force: true })
  process.exit(code ?? 1)
})
