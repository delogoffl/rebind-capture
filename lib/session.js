/**
 * The shape of a session, and the rules for growing one.
 *
 * Pure data and pure functions — no filesystem, no Electron, no DOM. The store
 * puts these on disk and the renderer draws them, but neither owns the rules,
 * which is what makes them testable in plain Node and what keeps two callers
 * from disagreeing about what a step number means.
 *
 * A session on disk is a directory:
 *
 *   <library>/<session id>/
 *     session.json          this model, serialised
 *     step-001.png          the full-size capture
 *     step-001.thumb.png    a 320px wide copy, which is all the grid ever reads
 *     rec-01.webm           a recording, in whatever container was negotiated
 *
 * Files rather than a database, deliberately. A screenshot tool whose output
 * you cannot find in a file manager is a screenshot tool people stop trusting,
 * and "open the folder" is a support answer that always works.
 */

import { reviveAnnotation } from './annotate.js'
import { isDigest } from './manifest.js'

/** Session and step ids are sortable, so a directory listing is chronological. */
export function makeId(prefix, when = Date.now()) {
  return `${prefix}-${when.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

const pad = (n, width = 3) => String(n).padStart(width, '0')

/**
 * A filesystem-safe slug that still reads like the thing it names.
 *
 * Windows forbids `<>:"/\|?*`, trailing dots and trailing spaces, and reserves
 * a handful of device names — `con.png` is not a file you can create. Rather
 * than enumerate the reserved list, anything that is not a letter, a digit or a
 * dash becomes a dash, and a leading digit-or-letter is guaranteed by the
 * prefix every caller supplies.
 */
/**
 * The untouched copy kept beside an annotated capture.
 *
 * Here rather than in `store.js` because both the renderer and main need it,
 * and `store.js` imports `node:fs` at the top level — importing it from a
 * sandboxed renderer fails to resolve and takes the whole view down with it.
 * This module is pure, which is exactly why it is the one both sides can share.
 *
 * Written the first time a step is marked up, so boxes and arrows can be taken
 * back off. A redaction deletes it — that is what makes a redaction a redaction
 * rather than a sticker — so whether this file exists is also the answer to
 * "can this step still be reverted?".
 */
export const originalName = (file) => String(file).replace(/\.png$/i, '.orig.png')

export function slug(text, max = 48) {
  const cleaned = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
  return cleaned || 'session'
}

const stamp = (when) => {
  const d = new Date(when)
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
}

/**
 * Named after when it started and what it was of.
 *
 * The date first, so a folder listing sorts chronologically without anyone
 * having to think about it; the label second, so you can still tell two runs on
 * the same afternoon apart.
 */
export function newSession({ label = '', when = Date.now() } = {}) {
  const name = label ? `${stamp(when)}-${slug(label)}` : stamp(when)
  return {
    id: makeId('s', when),
    name,
    label,
    startedAt: when,
    updatedAt: when,
    steps: [],
    media: [],
    notes: ''
  }
}

/**
 * Add a capture to a session.
 *
 * The index is `steps.length + 1` rather than a stored counter, so a deleted
 * step cannot leave a hole that the next capture falls into and duplicates.
 * Renumbering after a delete is `renumber` below, and it is deliberate rather
 * than automatic — see the note there.
 */
export function addStep(session, step) {
  const index = session.steps.length + 1
  const entry = {
    id: makeId('st', step.capturedAt || Date.now()),
    index,
    title: step.title || `Step ${index}`,
    mode: step.mode || 'screen',
    file: `step-${pad(index)}.png`,
    thumb: `step-${pad(index)}.thumb.png`,
    width: step.width || 0,
    height: step.height || 0,
    bytes: step.bytes || 0,
    capturedAt: step.capturedAt || Date.now(),
    /** Where the pointer was, in image pixels, so a marker can be put back. */
    cursor: step.cursor || null,
    source: step.source || null,
    meta: step.meta || null,
    annotations: [],
    /**
     * SHA-256 of the bytes as written, so an export can be verified later.
     *
     * Recorded at capture rather than at export: a digest taken when the pack
     * is built certifies the file as it was at export time, which is the moment
     * an alteration would already have happened.
     */
    sha256: step.sha256 || null,
    /** The digest before annotation, kept unless a redaction destroyed it. */
    originalSha256: null,
    /** Which recording this was pulled out of, when it was not a screenshot. */
    from: step.from || null
  }
  session.steps.push(entry)
  session.updatedAt = entry.capturedAt
  return entry
}

export function addMedia(session, media) {
  const index = session.media.length + 1
  const entry = {
    id: makeId('m', media.startedAt || Date.now()),
    index,
    file: `rec-${pad(index, 2)}.${media.container || 'webm'}`,
    container: media.container || 'webm',
    mimeType: media.mimeType || 'video/webm',
    width: media.width || 0,
    height: media.height || 0,
    durationMs: media.durationMs || 0,
    bytes: media.bytes || 0,
    startedAt: media.startedAt || Date.now(),
    source: media.source || null,
    audio: media.audio || null,
    sha256: media.sha256 || null,
    /**
     * What the input hook saw during the take, and when it was paused.
     *
     * Kept with the recording rather than consumed at stop, so steps can be
     * extracted from it later — after watching it back, or on a second pass
     * with different settings — instead of only in the moment it ended.
     */
    marks: Array.isArray(media.marks) ? media.marks : [],
    pauses: Array.isArray(media.pauses) ? media.pauses : []
  }
  session.media.push(entry)
  session.updatedAt = entry.startedAt
  return entry
}

/**
 * Close the gaps after a delete — on request, not automatically.
 *
 * Automatic renumbering is wrong for this product. The numbers are printed into
 * exported evidence, and somebody may already be holding a PDF that says "step
 * 7"; silently turning a different capture into step 7 the moment an earlier
 * one is deleted rewrites what that document refers to. So a session can have a
 * gap in it, the library shows the gap, and closing it is something the user
 * decides to do.
 *
 * The on-disk filenames are returned as rename pairs rather than applied here,
 * because this module does not touch the filesystem.
 */
export function renumber(session) {
  const renames = []
  session.steps.forEach((step, i) => {
    const index = i + 1
    if (step.index === index) return
    renames.push(
      { from: step.file, to: `step-${pad(index)}.png` },
      { from: step.thumb, to: `step-${pad(index)}.thumb.png` }
    )
    step.index = index
    step.file = `step-${pad(index)}.png`
    step.thumb = `step-${pad(index)}.thumb.png`
    // A title the user never wrote tracked the old number and is now a lie.
    if (/^Step \d+$/.test(step.title)) step.title = `Step ${index}`
  })
  session.updatedAt = Date.now()
  return renames
}

export function removeStep(session, stepId) {
  const at = session.steps.findIndex((s) => s.id === stepId)
  if (at < 0) return null
  const [gone] = session.steps.splice(at, 1)
  session.updatedAt = Date.now()
  return gone
}

export function removeMedia(session, mediaId) {
  const at = session.media.findIndex((m) => m.id === mediaId)
  if (at < 0) return null
  const [gone] = session.media.splice(at, 1)
  session.updatedAt = Date.now()
  return gone
}

/** Totals for the sidebar, computed rather than stored so they cannot drift. */
export function summarise(session) {
  const bytes =
    session.steps.reduce((n, s) => n + (s.bytes || 0), 0) +
    session.media.reduce((n, m) => n + (m.bytes || 0), 0)
  return {
    id: session.id,
    name: session.name,
    label: session.label,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    steps: session.steps.length,
    media: session.media.length,
    // A session that captured nothing and recorded nothing is a stray folder,
    // and the library offers to clear those rather than listing them forever.
    empty: session.steps.length === 0 && session.media.length === 0,
    bytes,
    duration: session.media.reduce((n, m) => n + (m.durationMs || 0), 0)
  }
}

/**
 * Repair whatever came off disk.
 *
 * A session.json can be older than the code reading it, hand-edited, or halfway
 * through a write that a power cut interrupted. Every field is defaulted and
 * every array is coerced, because one malformed file must not take the whole
 * library down with it — the alternative is an app that will not open.
 */
export function reviveSession(raw) {
  if (!raw || typeof raw !== 'object') return null
  const when = Number(raw.startedAt) || Date.now()
  const steps = Array.isArray(raw.steps) ? raw.steps.filter((s) => s && s.file) : []
  const media = Array.isArray(raw.media) ? raw.media.filter((m) => m && m.file) : []
  return {
    id: String(raw.id || makeId('s', when)),
    name: String(raw.name || stamp(when)),
    label: String(raw.label || ''),
    startedAt: when,
    updatedAt: Number(raw.updatedAt) || when,
    notes: String(raw.notes || ''),
    steps: steps.map((s, i) => ({
      ...s,
      id: String(s.id || makeId('st', when)),
      index: Number(s.index) || i + 1,
      title: String(s.title || `Step ${i + 1}`),
      // Marks are dropped rather than repaired if they are malformed: a mark
      // that cannot be drawn correctly is worse than no mark, because a
      // redaction rendered in the wrong place is a redaction that did not
      // happen while the report goes on counting it.
      annotations: Array.isArray(s.annotations)
        ? s.annotations.map(reviveAnnotation).filter(Boolean)
        : [],
      sha256: isDigest(s.sha256) ? s.sha256 : null,
      originalSha256: isDigest(s.originalSha256) ? s.originalSha256 : null
    })),
    media: media.map((m, i) => ({
      ...m,
      id: String(m.id || makeId('m', when)),
      index: Number(m.index) || i + 1,
      sha256: isDigest(m.sha256) ? m.sha256 : null,
      marks: Array.isArray(m.marks) ? m.marks : [],
      pauses: Array.isArray(m.pauses) ? m.pauses : []
    }))
  }
}
