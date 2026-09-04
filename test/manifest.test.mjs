/**
 * The integrity manifest.
 *
 * The claim this feature makes is narrow and worth stating exactly: it cannot
 * prove a pack is genuine — nothing offline can — but it makes *alteration*
 * detectable. These tests are mostly about that boundary, because a verifier
 * that quietly passes a modified file is worse than none at all.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  digest, canonical, buildManifest, manifestDigest, manifestText,
  checksumFile, verifyManifest, describeVerification, isDigest, CHECKSUM_FILE
} from '../lib/manifest.js'
import { newSession, addStep, addMedia } from '../lib/session.js'

const bytes = (...values) => new Uint8Array(values)

async function fixture({ steps = 2, media = 1 } = {}) {
  const session = newSession({ label: 'Checkout run' })
  for (let i = 0; i < steps; i++) {
    const step = addStep(session, { width: 1920, height: 1080, bytes: 1000 * (i + 1) })
    step.sha256 = await digest(bytes(i + 1, i + 2, i + 3))
  }
  for (let i = 0; i < media; i++) {
    const item = addMedia(session, { container: 'mp4', bytes: 5000, durationMs: 30_000 })
    item.sha256 = await digest(bytes(200 + i))
  }
  return session
}

describe('hashing', () => {
  test('a known vector, so the algorithm is not merely self-consistent', async () => {
    // SHA-256 of the empty input, which every implementation agrees on.
    assert.equal(
      await digest(new Uint8Array(0)),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    assert.equal(
      await digest('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  test('one changed byte changes the digest', async () => {
    const a = await digest(bytes(1, 2, 3, 4))
    const b = await digest(bytes(1, 2, 3, 5))
    assert.notEqual(a, b)
    assert.ok(isDigest(a) && isDigest(b))
  })

  test('digests are lowercase hex of a fixed length, because that is what is compared', async () => {
    assert.match(await digest('anything'), /^[0-9a-f]{64}$/)
    assert.ok(!isDigest('NOTAHASH'))
    assert.ok(!isDigest(''))
    assert.ok(!isDigest(null))
  })
})

describe('canonical form', () => {
  test('key order cannot change the digest', () => {
    assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }))
  })

  test('but a value change does', () => {
    assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }))
  })

  test('arrays keep their order, since order is meaning there', () => {
    assert.notEqual(canonical([1, 2]), canonical([2, 1]))
  })

  test('undefined is dropped rather than serialised inconsistently', () => {
    assert.equal(canonical({ a: 1, b: undefined }), canonical({ a: 1 }))
  })
})

describe('building a manifest', () => {
  test('every asset is listed with the digest recorded when it was written', async () => {
    const session = await fixture({ steps: 2, media: 1 })
    const manifest = buildManifest({ session, steps: session.steps, media: session.media })

    assert.equal(manifest.entries.length, 3)
    assert.equal(manifest.counts.steps, 2)
    assert.equal(manifest.counts.recordings, 1)
    assert.equal(manifest.counts.unhashed, 0)
    for (const entry of manifest.entries) assert.ok(isDigest(entry.sha256), entry.path)
  })

  test('an unhashed asset is listed and counted, not quietly omitted', () => {
    const session = newSession()
    addStep(session, { width: 100, height: 100, bytes: 10 })
    const manifest = buildManifest({ session, steps: session.steps })

    assert.equal(manifest.entries.length, 1)
    assert.equal(manifest.entries[0].sha256, null)
    // The pack that silently drops the one file nobody hashed is exactly the
    // pack a reviewer needs warning about.
    assert.equal(manifest.counts.unhashed, 1)
  })

  test('an annotated step says so, and keeps the digest it had before', async () => {
    const session = await fixture({ steps: 1, media: 0 })
    const step = session.steps[0]
    step.originalSha256 = step.sha256
    step.sha256 = await digest(bytes(9, 9, 9))
    step.annotations = [{ type: 'redact' }, { type: 'box' }]

    const entry = buildManifest({ session, steps: session.steps }).entries[0]
    assert.equal(entry.edited, true)
    assert.equal(entry.redactions, 1)
    assert.equal(entry.originalSha256, await digest(bytes(1, 2, 3)))
    assert.notEqual(entry.sha256, entry.originalSha256)
  })

  test('paths are the ones the export actually writes', async () => {
    const session = await fixture({ steps: 1, media: 1 })
    const manifest = buildManifest({
      session,
      steps: session.steps,
      media: session.media,
      paths: { step: (s) => `run/steps/${s.file}`, media: (m) => `run/${m.file}` }
    })
    assert.equal(manifest.entries[0].path, 'run/steps/step-001.png')
    assert.equal(manifest.entries[1].path, 'run/rec-01.mp4')
  })
})

describe('the manifest hashes itself', () => {
  test('the same facts always produce the same digest', async () => {
    const session = await fixture({ steps: 2, media: 1 })
    const at = 1_700_000_000_000
    const a = buildManifest({ session, steps: session.steps, media: session.media, generatedAt: at })
    const b = buildManifest({ session, steps: session.steps, media: session.media, generatedAt: at })
    assert.equal(await manifestDigest(a), await manifestDigest(b))
  })

  test('editing a digest inside the manifest changes the manifest digest', async () => {
    const session = await fixture({ steps: 2 })
    const manifest = buildManifest({ session, steps: session.steps })
    const before = await manifestDigest(manifest)

    manifest.entries[0].sha256 = await digest('forged')
    assert.notEqual(await manifestDigest(manifest), before,
      'rewriting a digest to match tampered bytes has to break the outer hash')
  })

  test('the manifest digest ignores its own self field', async () => {
    // Otherwise stamping the digest into the file would invalidate it.
    const session = await fixture({ steps: 1 })
    const manifest = buildManifest({ session, steps: session.steps })
    const before = await manifestDigest(manifest)
    manifest.self = before
    assert.equal(await manifestDigest(manifest), before)
  })

  test('it serialises as readable JSON', async () => {
    const session = await fixture({ steps: 1 })
    const text = manifestText(buildManifest({ session, steps: session.steps }))
    assert.match(text, /\n {2}"tool": "Rebind Capture"/)
    assert.ok(text.endsWith('\n'))
    assert.doesNotThrow(() => JSON.parse(text))
  })
})

describe('the checksum file', () => {
  test('is the format sha256sum already understands', async () => {
    const session = await fixture({ steps: 2, media: 0 })
    const text = checksumFile(buildManifest({ session, steps: session.steps }))
    // Two spaces between digest and path is the format, not a typo.
    for (const line of text.trim().split('\n')) {
      assert.match(line, /^[0-9a-f]{64} {2}\S+$/, line)
    }
    assert.equal(CHECKSUM_FILE, 'SHA256SUMS')
  })

  test('unhashed entries are left out, since there is nothing to check them against', () => {
    const session = newSession()
    addStep(session, { width: 10, height: 10, bytes: 1 })
    assert.equal(checksumFile(buildManifest({ session, steps: session.steps })), '')
  })
})

describe('verifying', () => {
  const actualFrom = (manifest) =>
    new Map(manifest.entries.map((entry) => [entry.path, entry.sha256]))

  test('an untouched pack is intact', async () => {
    const session = await fixture({ steps: 2, media: 1 })
    const manifest = buildManifest({ session, steps: session.steps, media: session.media })
    const result = verifyManifest(manifest, actualFrom(manifest))

    assert.equal(result.intact, true)
    assert.equal(result.checked, 3)
    assert.deepEqual(result.modified, [])
    assert.equal(describeVerification(result), '3 files verified')
  })

  test('a changed file is named, not just counted', async () => {
    const session = await fixture({ steps: 2 })
    const manifest = buildManifest({ session, steps: session.steps })
    const actual = actualFrom(manifest)
    actual.set('steps/step-002.png', await digest('tampered'))

    const result = verifyManifest(manifest, actual)
    assert.equal(result.intact, false)
    assert.deepEqual(result.modified, ['steps/step-002.png'])
    assert.deepEqual(result.ok, ['steps/step-001.png'])
    assert.match(describeVerification(result), /1 modified/)
  })

  test('missing and modified are different findings', async () => {
    const session = await fixture({ steps: 2 })
    const manifest = buildManifest({ session, steps: session.steps })
    const actual = actualFrom(manifest)
    actual.delete('steps/step-001.png')
    actual.set('steps/step-002.png', await digest('tampered'))

    const result = verifyManifest(manifest, actual)
    assert.deepEqual(result.missing, ['steps/step-001.png'])
    assert.deepEqual(result.modified, ['steps/step-002.png'])
    // Collapsing these into one boolean throws away the useful half.
    assert.match(describeVerification(result), /1 modified · 1 missing/)
  })

  test('an unhashed entry cannot be called intact', () => {
    const session = newSession()
    addStep(session, { width: 10, height: 10, bytes: 1 })
    const manifest = buildManifest({ session, steps: session.steps })
    const result = verifyManifest(manifest, new Map([['steps/step-001.png', 'whatever']]))

    assert.equal(result.intact, false)
    assert.deepEqual(result.unverified, ['steps/step-001.png'])
  })

  test('an extra file is reported but does not fail the pack', async () => {
    const session = await fixture({ steps: 1, media: 0 })
    const manifest = buildManifest({ session, steps: session.steps })
    const actual = actualFrom(manifest)
    actual.set('notes-from-the-reviewer.txt', await digest('mine'))

    const result = verifyManifest(manifest, actual)
    assert.equal(result.intact, true, 'a reviewer adding their own notes has not broken anything')
    assert.deepEqual(result.extra, ['notes-from-the-reviewer.txt'])
  })
})
