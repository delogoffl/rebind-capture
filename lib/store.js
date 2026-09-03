/**
 * The library on disk.
 *
 * One directory per session under a root the user can open in their file
 * manager, because a capture tool whose output you cannot find is one people
 * stop trusting. Everything here takes the root as an argument rather than
 * reading it from Electron, so the whole module runs — and is tested — in plain
 * Node against a temporary directory.
 *
 * Writes are atomic: a temp file beside the target, then a rename. A rename
 * within one filesystem is atomic on every platform this ships to, so a crash
 * or a power cut mid-write leaves either the old file or the new one, never a
 * half-written `session.json` that takes the library down on next launch.
 */

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { reviveSession, summarise } from './session.js'

const INDEX = 'session.json'

/* ──────────────────────────────────────────────────────────── primitives */

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Write, then move into place.
 *
 * The temp name carries the pid and a counter rather than a timestamp: two
 * writes in the same millisecond are ordinary here (a step's PNG and its
 * thumbnail land together) and would otherwise collide on the temp path.
 */
let tick = 0
export async function writeAtomic(file, data) {
  const temp = `${file}.${process.pid}.${++tick}.tmp`
  await ensureDir(dirname(file))
  await fs.writeFile(temp, data)
  try {
    await fs.rename(temp, file)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw err
  }
  return file
}

export const sessionDir = (root, id) => join(root, id)
const indexFile = (root, id) => join(sessionDir(root, id), INDEX)

/* ─────────────────────────────────────────────────────────────── sessions */

export async function saveSession(root, session) {
  await ensureDir(sessionDir(root, session.id))
  await writeAtomic(indexFile(root, session.id), `${JSON.stringify(session, null, 2)}\n`)
  return session
}

export async function loadSession(root, id) {
  try {
    const text = await fs.readFile(indexFile(root, id), 'utf8')
    return reviveSession(JSON.parse(text))
  } catch {
    // A directory with no readable index is not a session. Returning null lets
    // the caller skip it instead of the whole listing failing.
    return null
  }
}

/**
 * Every session, newest first.
 *
 * Directories are read rather than a central index kept, and that is on
 * purpose: a central index is a second source of truth that goes stale the
 * moment somebody moves a folder, and this one is meant to be moved.
 */
export async function listSessions(root) {
  let entries = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => loadSession(root, entry.name))
  )

  return found
    .filter(Boolean)
    .map(summarise)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteSession(root, id) {
  await fs.rm(sessionDir(root, id), { recursive: true, force: true })
  return true
}

/* ────────────────────────────────────────────────────────────────── files */

export async function writeAsset(root, sessionId, name, data) {
  const file = join(sessionDir(root, sessionId), name)
  await writeAtomic(file, data)
  const stat = await fs.stat(file)
  return { file, path: file, bytes: stat.size }
}

export async function readAsset(root, sessionId, name) {
  return fs.readFile(join(sessionDir(root, sessionId), name))
}

export async function removeAsset(root, sessionId, name) {
  await fs.rm(join(sessionDir(root, sessionId), name), { force: true })
}

/**
 * Apply the rename pairs `renumber` produced.
 *
 * Two passes through a temporary name, because renumbering shifts every file
 * down by one and a direct rename would overwrite the next file in the
 * sequence before it had been moved. Step 3 becoming step 2 destroys step 2
 * unless step 2 has already been got out of the way.
 */
export async function applyRenames(root, sessionId, renames) {
  const dir = sessionDir(root, sessionId)
  const staged = []

  for (const { from, to } of renames) {
    const source = join(dir, from)
    const temp = `${source}.renaming`
    try {
      await fs.rename(source, temp)
      staged.push({ temp, target: join(dir, to) })
    } catch {
      // A missing file is not worth failing a renumber over; the index no
      // longer references it either way.
    }
  }

  for (const { temp, target } of staged) {
    await fs.rename(temp, target).catch(() => {})
  }
  return staged.length
}

/* ───────────────────────────────────────────────────────────── housekeeping */

/**
 * Bytes on disk for the whole library.
 *
 * Walked rather than summed from the indexes: the point of showing it is to
 * account for the space actually being used, including anything the indexes
 * have lost track of.
 */
export async function libraryBytes(root) {
  let total = 0
  const walk = async (dir) => {
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }
  await walk(root)
  return total
}

/**
 * Drop sessions that captured nothing.
 *
 * A session is created the moment the user arms the app, so quitting without
 * capturing leaves an empty folder. Left alone they accumulate and every one of
 * them is a row in the library that means nothing.
 */
export async function pruneEmpty(root) {
  const sessions = await listSessions(root)
  const empty = sessions.filter((s) => s.empty)
  for (const session of empty) await deleteSession(root, session.id)
  return empty.length
}

/**
 * Files in a session directory that the index does not mention.
 *
 * These happen: a crash between writing a PNG and saving the index, or a
 * recording whose save was interrupted. Reporting them rather than deleting
 * them is the right default for an evidence tool — the orphan may be the only
 * copy of something that mattered.
 */
export async function orphans(root, id) {
  const session = await loadSession(root, id)
  if (!session) return []
  const known = new Set([
    INDEX,
    ...session.steps.flatMap((s) => [s.file, s.thumb]),
    ...session.media.map((m) => m.file)
  ])
  const entries = await fs.readdir(sessionDir(root, id)).catch(() => [])
  return entries.filter((name) => !known.has(name) && !name.endsWith('.tmp'))
}
