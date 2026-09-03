/**
 * Turning a session into files.
 *
 * The work is split so that neither half has to pretend to be the other. This
 * module decides *what* files an export produces and what they are called; it
 * is handed a `read` for the bytes and, for PDF, a `toJpeg` for the encoding,
 * because the JPEG encoder lives on a canvas and the canvas lives in the
 * renderer. Main writes what comes back.
 *
 * That indirection is also what makes this testable: the tests pass a `read`
 * backed by a Map and assert on the plan, with no Electron and no DOM in sight.
 *
 * Four formats, and what each is actually for:
 *
 *   pdf     the deliverable. One step per page, numbered, with its metadata.
 *   png     the raw evidence. One file, or a folder when there is more than one.
 *   md      a report to paste into a ticket, with the images beside it.
 *   video   the recordings, each as its own file.
 */

import { pdf } from './pdf.js'
import { zip } from './zip.js'
import { markdown } from './report.js'
import { slug } from './session.js'

const pad = (n) => String(n).padStart(3, '0')

export const humanBytes = (bytes) => {
  if (!bytes || bytes < 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Roughly how big the result will be, before doing the work.
 *
 * Rough is the point: it goes on a button so the user knows whether they are
 * about to write 4 MB or 400, and a number that took two seconds of encoding to
 * produce would be a worse button. The PDF ratio is measured rather than
 * guessed — JPEG at quality 0.85, capped at 1600px wide, lands near a fifth of
 * the source PNG across the captures this tool produces.
 */
export function estimate(format, steps = [], media = []) {
  const stepBytes = steps.reduce((n, s) => n + (s.bytes || 0), 0)
  switch (format) {
    case 'pdf': return Math.round(stepBytes * 0.22) + 12_000
    case 'png': return stepBytes + (steps.length > 1 ? steps.length * 120 : 0)
    case 'md': return stepBytes + 4_000
    case 'video': return media.reduce((n, m) => n + (m.bytes || 0), 0)
    default: return 0
  }
}

/** What the export will be called on disk, before it runs. */
export function outputName(format, session, { steps = [], media = [] } = {}) {
  const base = slug(session?.label || session?.name)
  switch (format) {
    case 'pdf': return `${base}.pdf`
    case 'md': return `${base}-report.zip`
    case 'png': return steps.length === 1 ? `${base}-step-${pad(steps[0].index)}.png` : `${base}-steps.zip`
    case 'video': return media.length === 1
      ? `${base}.${media[0].container || 'webm'}`
      : `${base}-recordings`
    default: return base
  }
}

/**
 * Build the files an export consists of.
 *
 * Returns `[{ name, data }]` rather than writing anything, so the caller
 * decides where they land — a folder the user picked, a temp directory a test
 * inspects, or nowhere at all.
 *
 * @param {object} options
 * @param {(file: string) => Promise<Uint8Array>} options.read  bytes of an asset by filename
 * @param {(bytes: Uint8Array) => Promise<{blob: Blob, width: number, height: number}>} [options.toJpeg]
 */
export async function buildExport(format, options) {
  const {
    session,
    steps = [],
    media = [],
    read,
    toJpeg,
    includeMeta = true,
    machine = {},
    onProgress
  } = options

  const base = slug(session?.label || session?.name)
  const tick = (done, total) => onProgress?.(done, total)

  if (format === 'video') {
    if (!media.length) throw new Error('Select at least one recording.')
    const files = []
    for (const [i, item] of media.entries()) {
      tick(i + 1, media.length)
      // Numbered only when there is more than one, so the common case keeps a
      // clean filename and two exports never overwrite each other.
      const suffix = media.length > 1 ? `-${pad(i + 1)}` : ''
      files.push({ name: `${base}${suffix}.${item.container || 'webm'}`, data: await read(item.file) })
    }
    return { files, kind: 'files' }
  }

  if (!steps.length) throw new Error('Select at least one step.')

  if (format === 'png') {
    if (steps.length === 1) {
      tick(1, 1)
      return {
        kind: 'file',
        files: [{ name: `${base}-step-${pad(steps[0].index)}.png`, data: await read(steps[0].file) }]
      }
    }
    const entries = []
    for (const [i, step] of steps.entries()) {
      entries.push({ path: `${base}/step-${pad(step.index)}.png`, data: await read(step.file) })
      tick(i + 1, steps.length)
    }
    return { kind: 'file', files: [{ name: `${base}-steps.zip`, data: await bytes(await zip(entries)) }] }
  }

  if (format === 'md') {
    const entries = []
    for (const [i, step] of steps.entries()) {
      entries.push({ path: `${base}/steps/step-${pad(step.index)}.png`, data: await read(step.file) })
      tick(i + 1, steps.length)
    }
    entries.unshift({
      path: `${base}/report.md`,
      data: markdown(session, steps, { includeMeta, machine, media })
    })
    return { kind: 'file', files: [{ name: `${base}-report.zip`, data: await bytes(await zip(entries)) }] }
  }

  if (format === 'pdf') {
    if (typeof toJpeg !== 'function') throw new Error('PDF export needs a JPEG encoder.')
    const pages = []
    for (const [i, step] of steps.entries()) {
      // Sequential, not `Promise.all`: a dozen simultaneous 4K decodes is how a
      // renderer gets killed halfway through an export that had nearly worked.
      pages.push({
        index: step.index,
        title: step.title,
        meta: metaFor(step),
        jpeg: await toJpeg(await read(step.file))
      })
      tick(i + 1, steps.length)
    }
    const blob = await pdf(pages, {
      title: session?.label || session?.name || 'Rebind Capture export',
      includeMeta
    })
    return { kind: 'file', files: [{ name: `${base}.pdf`, data: await bytes(blob) }] }
  }

  throw new Error(`Unknown export format: ${format}`)
}

/** The PDF writer wants the extension's metadata shape; this is the desktop's. */
function metaFor(step) {
  if (!step.meta && !step.source) return null
  return {
    url: step.source?.name || step.meta?.url || '',
    at: step.capturedAt ? new Date(step.capturedAt).toISOString() : '',
    viewport: step.width ? `${step.width}×${step.height}` : '',
    ua: step.meta?.ua || ''
  }
}

const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer())
