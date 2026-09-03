/**
 * Exporting.
 *
 * `buildExport` is handed a `read` and a `toJpeg` rather than reaching for the
 * filesystem or a canvas, which is exactly what makes it testable here: a Map
 * stands in for the library and a stub stands in for the encoder, and the
 * assertions are about the plan — which files, called what, containing what.
 *
 * The recording tests are the ones that matter most. The browser extension this
 * grew out of shipped a video export that called `.pop()` on the session's
 * recordings and exported that one, whatever was selected, so a session with
 * six takes had five that could not be reached.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildExport, estimate, outputName, humanBytes } from '../lib/export.js'
import { markdown, frontMatter } from '../lib/report.js'
import { newSession, addStep, addMedia } from '../lib/session.js'

/** A session with `steps` captures and `media` recordings, and a reader for it. */
function fixture({ steps = 2, media = 0, label = 'Checkout run' } = {}) {
  const session = newSession({ label })
  const files = new Map()

  for (let i = 0; i < steps; i++) {
    // Realistic sizes. A 1920x1080 PNG screenshot is one to three megabytes,
    // and the PDF estimate has a fixed overhead that only looks wrong against
    // toy numbers.
    const entry = addStep(session, { width: 1920, height: 1080, bytes: 1_500_000 * (i + 1) })
    entry.title = `Step about ${i + 1}`
    files.set(entry.file, new Uint8Array(64).fill(i + 1))
  }
  for (let i = 0; i < media; i++) {
    const entry = addMedia(session, { container: 'mp4', bytes: 5000 * (i + 1), durationMs: 30_000 })
    files.set(entry.file, new Uint8Array(128).fill(100 + i))
  }

  const read = async (name) => {
    if (!files.has(name)) throw new Error(`missing ${name}`)
    return files.get(name)
  }
  // The real encoder is a canvas; the PDF writer only needs bytes and a size.
  const toJpeg = async () => ({
    blob: new Blob([new Uint8Array(32).fill(0xFF)], { type: 'image/jpeg' }),
    width: 1600, height: 900
  })
  return { session, files, read, toJpeg }
}

describe('estimates and names', () => {
  test('the estimate tracks the selection, not the session', () => {
    const { session } = fixture({ steps: 3, media: 2 })
    const all = estimate('png', session.steps, [])
    const some = estimate('png', session.steps.slice(0, 1), [])
    assert.ok(some < all, 'fewer steps must estimate smaller')

    // A number under an Export button has to be the size of the thing that
    // button writes, so video counts only what was passed in.
    const oneTape = estimate('video', [], session.media.slice(0, 1))
    const bothTapes = estimate('video', [], session.media)
    assert.equal(oneTape, 5000)
    assert.equal(bothTapes, 15_000)
  })

  test('a PDF estimates well below the source PNGs', () => {
    const { session } = fixture({ steps: 4 })
    assert.ok(estimate('pdf', session.steps, []) < estimate('png', session.steps, []))
  })

  test('names are predictable before the work runs', () => {
    const { session } = fixture({ steps: 2, media: 1 })
    assert.equal(outputName('pdf', session), 'checkout-run.pdf')
    assert.equal(outputName('md', session), 'checkout-run-report.zip')
    assert.equal(outputName('png', session, { steps: session.steps }), 'checkout-run-steps.zip')
    assert.equal(outputName('png', session, { steps: [session.steps[0]] }), 'checkout-run-step-001.png')
    assert.equal(outputName('video', session, { media: session.media }), 'checkout-run.mp4')
  })

  test('bytes read the way people say them', () => {
    assert.equal(humanBytes(0), '0 KB')
    assert.equal(humanBytes(2048), '2 KB')
    assert.equal(humanBytes(5 * 1024 * 1024), '5.0 MB')
    assert.equal(humanBytes(3 * 1024 ** 3), '3.00 GB')
  })
})

describe('exporting recordings', () => {
  test('exactly the recordings passed in, and no others', async () => {
    const { session, read } = fixture({ steps: 1, media: 3 })
    const chosen = [session.media[0], session.media[2]]

    const plan = await buildExport('video', { session, steps: [], media: chosen, read })

    assert.equal(plan.files.length, 2, 'two chosen means two files')
    // The old bug: `.pop()` would have produced exactly one file, and it would
    // have been the third — the one that was not asked for on its own.
    assert.equal(plan.files[0].data[0], 100, 'the first chosen recording')
    assert.equal(plan.files[1].data[0], 102, 'the third chosen recording')
  })

  test('several files are numbered so they cannot overwrite each other', async () => {
    const { session, read } = fixture({ steps: 0, media: 3 })
    const plan = await buildExport('video', { session, steps: [], media: session.media, read })
    const names = plan.files.map((f) => f.name)
    assert.equal(new Set(names).size, 3, `names must be distinct: ${names.join(', ')}`)
    assert.deepEqual(names, ['checkout-run-001.mp4', 'checkout-run-002.mp4', 'checkout-run-003.mp4'])
  })

  test('one file keeps a clean name', async () => {
    const { session, read } = fixture({ steps: 0, media: 2 })
    const plan = await buildExport('video', { session, steps: [], media: [session.media[1]], read })
    assert.deepEqual(plan.files.map((f) => f.name), ['checkout-run.mp4'])
  })

  test('nothing selected is an error the user can act on', async () => {
    const { session, read } = fixture({ steps: 1, media: 2 })
    await assert.rejects(
      () => buildExport('video', { session, steps: [], media: [], read }),
      /Select at least one recording/
    )
  })
})

describe('exporting steps', () => {
  test('a single PNG is a single PNG, not a zip of one', async () => {
    const { session, read } = fixture({ steps: 3 })
    const plan = await buildExport('png', { session, steps: [session.steps[1]], read })
    assert.equal(plan.files.length, 1)
    assert.equal(plan.files[0].name, 'checkout-run-step-002.png')
    assert.equal(plan.files[0].data[0], 2, 'the bytes of the step that was chosen')
  })

  test('several PNGs come back as one archive', async () => {
    const { session, read } = fixture({ steps: 3 })
    const plan = await buildExport('png', { session, steps: session.steps, read })
    assert.equal(plan.files.length, 1)
    assert.equal(plan.files[0].name, 'checkout-run-steps.zip')
    // "PK\003\004" — a real local file header, so an unarchiver will open it.
    const head = plan.files[0].data.slice(0, 4)
    assert.deepEqual([...head], [0x50, 0x4B, 0x03, 0x04])
  })

  test('a PDF is produced, and refuses to guess at a missing encoder', async () => {
    const { session, read, toJpeg } = fixture({ steps: 2 })
    const plan = await buildExport('pdf', { session, steps: session.steps, read, toJpeg })
    const text = new TextDecoder('latin1').decode(plan.files[0].data)
    assert.equal(plan.files[0].name, 'checkout-run.pdf')
    assert.match(text, /^%PDF-1\.[0-9]/)
    assert.match(text, /%%EOF\s*$/)
    // One page per step is the document's whole shape.
    assert.equal((text.match(/\/Type\s*\/Page[^s]/g) || []).length, 2)

    await assert.rejects(
      () => buildExport('pdf', { session, steps: session.steps, read }),
      /JPEG encoder/
    )
  })

  test('progress is reported per step, so a long export is not a frozen button', async () => {
    const { session, read } = fixture({ steps: 4 })
    const seen = []
    await buildExport('png', {
      session, steps: session.steps, read, onProgress: (done, total) => seen.push([done, total])
    })
    assert.deepEqual(seen, [[1, 4], [2, 4], [3, 4], [4, 4]])
  })

  test('an unknown format is refused rather than silently doing nothing', async () => {
    const { session, read } = fixture()
    await assert.rejects(
      () => buildExport('tiff', { session, steps: session.steps, read }),
      /Unknown export format/
    )
  })
})

describe('the markdown report', () => {
  test('front matter carries what a reviewer needs to trust the images', () => {
    const { session } = fixture({ steps: 2 })
    const lines = frontMatter(session, session.steps, { machine: { platform: 'Windows 11', display: '2560×1440' } })
    const text = lines.join('\n')
    assert.match(text, /^---/)
    assert.match(text, /session: "20\d{6}-\d{6}-checkout-run"/)
    assert.match(text, /tool: "Rebind Capture"/)
    assert.match(text, /platform: "Windows 11"/)
    assert.match(text, /steps: 2/)
    // Counted rather than omitted: a report that looks identical whether or not
    // something was blacked out is worse than one that says so.
    assert.match(text, /redactions: 0/)
  })

  test('redactions are counted even though what was hidden is not shown', () => {
    const { session } = fixture({ steps: 2 })
    session.steps[0].annotations = [{ type: 'redact' }, { type: 'arrow' }, { type: 'redact' }]
    const text = markdown(session, session.steps, { includeMeta: true })
    assert.match(text, /redactions: 2/)
    assert.match(text, /annotations: 3/)
    assert.match(text, /2 redactions/)
  })

  test('images are referenced at the path the zip actually puts them', () => {
    const { session } = fixture({ steps: 2 })
    const text = markdown(session, session.steps, { includeMeta: false })
    assert.match(text, /!\[Step 1]\(steps\/step-001\.png\)/)
    assert.match(text, /!\[Step 2]\(steps\/step-002\.png\)/)
    assert.ok(!text.startsWith('---'), 'metadata off means no front matter')
  })

  test('recordings are listed so the zip is self-describing', () => {
    const { session } = fixture({ steps: 1, media: 2 })
    const text = markdown(session, session.steps, { media: session.media })
    assert.match(text, /## Recordings/)
    assert.match(text, /rec-01\.mp4/)
    assert.match(text, /00:30/)
  })

  test('a title with quotes cannot break the front matter', () => {
    const session = newSession({ label: 'He said "run it"' })
    const text = frontMatter(session, [], {}).join('\n')
    // JSON quoting is valid YAML quoting, which is the point of using it.
    assert.ok(text.includes('\\"run it\\"'), text)
  })
})
