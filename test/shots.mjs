/**
 * Screenshot the app, as it actually runs.
 *
 * Not a test — a look. Electron's own `capturePage` is used rather than a
 * browser automation tool, because the thing worth photographing is the real
 * window with the real main process behind it: the frameless title bar, the
 * custom scheme, the sandboxed renderer, and the IPC that feeds every view.
 *
 * It runs against a temporary userData directory seeded with a few sessions, so
 * the Library has something in it and the library of whoever runs this is never
 * touched.
 *
 *   node test/shots.mjs           every view, both themes
 *   node test/shots.mjs light     one of them
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { encodePng } from '../scripts/make-icons.mjs'
import { newSession, addStep, addMedia } from '../lib/session.js'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT = join(ROOT, 'shots')

const themes = process.argv.slice(2).length ? process.argv.slice(2) : ['dark', 'light']
const profile = mkdtempSync(join(tmpdir(), 'rebind-capture-shots-'))
const library = join(profile, 'library')

/* ─── a library worth photographing ─────────────────────────────────────── */

/** A gradient square, through the same PNG encoder the icons use. */
function tile(size, from, to) {
  const px = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x / size + y / size) / 2
      const i = (y * size + x) * 4
      px[i] = from[0] + (to[0] - from[0]) * t
      px[i + 1] = from[1] + (to[1] - from[1]) * t
      px[i + 2] = from[2] + (to[2] - from[2]) * t
      px[i + 3] = 255
    }
  }
  return encodePng(px, size)
}

const PALETTE = [
  [[79, 70, 229], [6, 182, 212]], [[124, 58, 237], [79, 70, 229]],
  [[8, 145, 178], [34, 211, 238]], [[67, 56, 202], [139, 92, 246]],
  [[14, 116, 144], [8, 145, 178]], [[99, 102, 241], [168, 85, 247]]
]
const TITLES = [
  'Chrome — Checkout', 'Chrome — Card details', 'Chrome — Pay now',
  'Chrome — Confirmation', 'Slack — #payments', 'Chrome — Receipt'
]

function seed(label, steps, tapes, ago) {
  const at = Date.now() - ago
  const session = newSession({ label, when: at })
  mkdirSync(join(library, session.id), { recursive: true })

  for (let i = 0; i < steps; i++) {
    const [from, to] = PALETTE[i % PALETTE.length]
    const entry = addStep(session, {
      width: 2560,
      height: 1440,
      bytes: 1_800_000 + i * 90_000,
      capturedAt: at + i * 42_000,
      cursor: { x: 1200, y: 700 },
      source: { kind: 'screen', name: TITLES[i % TITLES.length] },
      meta: { platform: 'Windows_NT 10.0.26200', display: '2560×1440', scale: 1.5 }
    })
    entry.title = TITLES[i % TITLES.length]
    const png = tile(360, from, to)
    writeFileSync(join(library, session.id, entry.file), png)
    writeFileSync(join(library, session.id, entry.thumb), png)
  }

  for (let i = 0; i < tapes; i++) {
    const entry = addMedia(session, {
      container: 'mp4',
      width: 2560,
      height: 1440,
      durationMs: (i + 1) * 47_000,
      bytes: (i + 1) * 3_400_000,
      startedAt: at + i * 300_000
    })
    writeFileSync(join(library, session.id, entry.file), Buffer.alloc(1024))
  }

  writeFileSync(join(library, session.id, 'session.json'), `${JSON.stringify(session, null, 2)}\n`)
  return session
}

mkdirSync(library, { recursive: true })
seed('Checkout payment bug', 6, 2, 40 * 60_000)
seed('Login regression', 3, 0, 3 * 3600_000)
seed('Release smoke test', 9, 1, 26 * 3600_000)

/* ─── drive the app ─────────────────────────────────────────────────────── */

/**
 * Electron needs a package directory, not a file.
 *
 * Handed a bare path to a `.cjs` it runs it in plain Node mode and
 * `require('electron')` comes back without the app APIs — so a throwaway
 * package is written whose `main` is the absolute path of the real driver.
 * `main.cjs` resolves everything against its own `__dirname`, so it still
 * serves the real renderer from the real project root.
 */
const appDir = mkdtempSync(join(tmpdir(), 'rebind-capture-app-'))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
writeFileSync(join(appDir, 'package.json'), JSON.stringify({
  name: 'rebind-capture-shots',
  // Without this `app.getVersion()` falls back to Electron's own version and
  // the title bar photographs as v38.x.
  version: pkg.version,
  // JSON.stringify escapes the Windows separators, so the path needs no
  // massaging of its own.
  main: join(HERE, 'shots-main.cjs')
}, null, 2))

const electron = require('electron')
// `--user-data-dir` is a Chromium switch, so it goes on argv. That is what
// keeps the run out of the real library and gives it a settings file of its
// own, so a previous run's choices cannot leak into the pictures.
const env = {
  ...process.env,
  REBIND_SHOTS_OUT: OUT,
  REBIND_SHOTS_THEMES: themes.join(',')
}
/**
 * Some toolchains export this, and it is inherited.
 *
 * With `ELECTRON_RUN_AS_NODE` set, the binary is a Node build: it runs the
 * entry as a plain script and `require('electron')` comes back as a path
 * string, so the first line of `main.cjs` fails on `protocol` being undefined.
 * The message names none of that, which is why it is worth deleting explicitly
 * rather than hoping the environment is clean.
 */
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, [appDir, `--user-data-dir=${profile}`], { stdio: 'inherit', env })

child.on('exit', (code) => {
  rmSync(profile, { recursive: true, force: true })
  rmSync(appDir, { recursive: true, force: true })
  console.log(code === 0 ? `shots/  ${themes.join(' and ')}` : `failed (exit ${code})`)
  process.exit(code ?? 1)
})
