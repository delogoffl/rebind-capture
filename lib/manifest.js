/**
 * Making an export checkable.
 *
 * The front matter of a report already says what was captured, when, on what
 * machine, and how much of it was edited. That is an audit trail with nothing
 * behind it: every line of it can be retyped, and so can the images. A reviewer
 * who receives a folder of screenshots has no way to tell whether they are the
 * ones that came out of the tool.
 *
 * So every asset is hashed when it is written, the digests travel with the
 * export, and the manifest is hashed too. None of that stops anyone forging a
 * pack from scratch — nothing offline can. What it does is make *alteration*
 * visible: change one pixel of one PNG after the fact and the digest no longer
 * matches, and change the digest and the manifest hash no longer matches. For a
 * bug report or a compliance walkthrough that is the difference between "here
 * are some pictures" and "here is a pack that is either intact or is not".
 *
 * Everything here is pure and works on plain objects, so the same code hashes
 * in the renderer (WebCrypto) and verifies in Node, and the tests need neither
 * Electron nor a DOM.
 */

export const MANIFEST_FILE = 'manifest.json'
export const CHECKSUM_FILE = 'SHA256SUMS'
export const ALGORITHM = 'sha256'

/** What a digest looks like, so a malformed one is rejected rather than compared. */
const HEX64 = /^[0-9a-f]{64}$/

export const isDigest = (value) => typeof value === 'string' && HEX64.test(value)

/**
 * SHA-256 of some bytes, as lowercase hex.
 *
 * WebCrypto where there is one — the renderer runs on a `capture://` origin
 * registered as secure, so `crypto.subtle` is available there — and Node's
 * built-in otherwise. Both are in the platform already; a hashing dependency
 * for a tool whose whole design is zero-dependency would be a poor trade.
 */
export async function digest(bytes) {
  const view = toBytes(bytes)
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const hash = await subtle.digest('SHA-256', view)
    return hex(new Uint8Array(hash))
  }
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(view).digest('hex')
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

function toBytes(input) {
  if (input instanceof Uint8Array) return input
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (typeof input === 'string') return new TextEncoder().encode(input)
  throw new TypeError('digest() takes bytes or a string')
}

/**
 * Serialise with sorted keys, so the same manifest always hashes the same.
 *
 * `JSON.stringify` preserves insertion order, which means a manifest built by
 * a slightly different code path would produce a different digest for identical
 * facts — and a verifier that disagrees with itself is worse than no verifier.
 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

/**
 * The manifest for a set of files.
 *
 * `entries` is what actually ships — path as it appears inside the export, the
 * digest recorded when the bytes were written, and enough about the asset to
 * tell what it is without opening it. Anything whose digest is missing or
 * malformed is listed with `sha256: null` rather than silently dropped: a pack
 * that quietly omits the one file nobody hashed is exactly the pack a reviewer
 * needs to be warned about.
 */
export function buildManifest({
  session,
  steps = [],
  media = [],
  machine = {},
  paths = {},
  generatedAt = Date.now()
} = {}) {
  const entries = []

  for (const step of steps) {
    entries.push(trim({
      path: paths.step ? paths.step(step) : `steps/${step.file}`,
      kind: 'step',
      index: step.index,
      title: step.title || undefined,
      bytes: step.bytes || 0,
      width: step.width || undefined,
      height: step.height || undefined,
      capturedAt: iso(step.capturedAt),
      sha256: isDigest(step.sha256) ? step.sha256 : null,
      // An annotated image is not the image the camera produced, and the pack
      // has to say so rather than leaving the digests to imply it.
      edited: step.annotations?.length ? true : undefined,
      originalSha256: isDigest(step.originalSha256) ? step.originalSha256 : undefined,
      redactions: countRedactions(step) || undefined
    }))
  }

  for (const item of media) {
    entries.push(trim({
      path: paths.media ? paths.media(item) : item.file,
      kind: 'recording',
      index: item.index,
      bytes: item.bytes || 0,
      durationMs: item.durationMs || 0,
      startedAt: iso(item.startedAt),
      sha256: isDigest(item.sha256) ? item.sha256 : null
    }))
  }

  return trim({
    version: 1,
    tool: 'Rebind Capture',
    algorithm: ALGORITHM,
    session: session?.name || 'session',
    label: session?.label || undefined,
    capturedAt: iso(session?.startedAt),
    generatedAt: iso(generatedAt),
    platform: machine.platform || undefined,
    osRelease: machine.release || undefined,
    appVersion: machine.appVersion || undefined,
    counts: {
      steps: steps.length,
      recordings: media.length,
      annotations: steps.reduce((n, s) => n + (s.annotations?.length || 0), 0),
      redactions: steps.reduce((n, s) => n + countRedactions(s), 0),
      unhashed: entries.filter((e) => !e.sha256).length
    },
    entries
  })
}

const countRedactions = (step) =>
  (step?.annotations || []).filter((a) => a?.type === 'redact').length

const iso = (when) => (when ? new Date(when).toISOString() : undefined)

/** Drop undefined so the canonical form does not depend on which fields were set. */
function trim(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** The manifest's own digest, which is what makes editing a digest pointless. */
export const manifestDigest = (manifest) => digest(canonical(withoutSelf(manifest)))

const withoutSelf = ({ self, ...rest }) => rest

/** The bytes written as `manifest.json`, pretty so a human can read it. */
export const manifestText = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`

/**
 * A `SHA256SUMS` file, in the format `sha256sum -c` already understands.
 *
 * The manifest is the machine-readable record; this is so a reviewer with no
 * special tooling — no Rebind Capture, no script — can verify the pack with a
 * command their operating system already ships. An evidence format that can
 * only be checked by the tool that produced it is not much of an evidence
 * format.
 */
export function checksumFile(manifest) {
  const lines = manifest.entries
    .filter((entry) => isDigest(entry.sha256))
    .map((entry) => `${entry.sha256}  ${entry.path}`)
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/**
 * Compare a manifest against the bytes actually present.
 *
 * `actual` maps path to digest — whatever the caller managed to read. A file it
 * could not read is `missing`, one whose digest differs is `modified`, one
 * present but never hashed is `unverified`, and anything not in the manifest at
 * all is `extra`. All four are reported, because "one file is missing" and "one
 * file was changed" are different findings and collapsing them into a single
 * boolean throws away the useful half.
 */
export function verifyManifest(manifest, actual) {
  const seen = new Map(
    actual instanceof Map ? actual : Object.entries(actual || {})
  )

  const ok = []
  const modified = []
  const missing = []
  const unverified = []

  for (const entry of manifest?.entries || []) {
    if (!isDigest(entry.sha256)) { unverified.push(entry.path); continue }
    if (!seen.has(entry.path)) { missing.push(entry.path); continue }
    const found = seen.get(entry.path)
    if (found === entry.sha256) ok.push(entry.path)
    else modified.push(entry.path)
  }

  const known = new Set((manifest?.entries || []).map((e) => e.path))
  const extra = [...seen.keys()].filter((path) => !known.has(path))

  return {
    // Intact means every file the manifest claims is present and unchanged.
    // Extras do not break that — a reviewer may have added their own notes to
    // the folder — but they are reported so nothing is silently ignored.
    intact: modified.length === 0 && missing.length === 0 && unverified.length === 0,
    ok,
    modified,
    missing,
    unverified,
    extra,
    checked: ok.length + modified.length
  }
}

/** One line a person can read, for a toast or a status row. */
export function describeVerification(result) {
  if (!result) return 'Not checked'
  if (result.intact) {
    return result.checked === 1 ? '1 file verified' : `${result.checked} files verified`
  }
  const parts = []
  if (result.modified.length) parts.push(`${result.modified.length} modified`)
  if (result.missing.length) parts.push(`${result.missing.length} missing`)
  if (result.unverified.length) parts.push(`${result.unverified.length} unhashed`)
  return parts.join(' · ') || 'Could not verify'
}
