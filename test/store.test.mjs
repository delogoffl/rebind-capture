/**
 * The library on disk.
 *
 * Against a real temporary directory rather than a mocked filesystem: the
 * interesting failures here are all filesystem behaviour — partial writes,
 * renames that collide, directories that are not what the index says they are —
 * and a mock is exactly the thing that would agree with the code instead of
 * with the OS.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  saveSession, loadSession, listSessions, deleteSession, writeAsset, readAsset,
  removeAsset, applyRenames, libraryBytes, pruneEmpty, orphans, sessionDir, writeAtomic,
  verifySession, hashAsset, originalName
} from '../lib/store.js'
import { newSession, addStep, addMedia, renumber, removeStep } from '../lib/session.js'

let root

before(() => { root = mkdtempSync(join(tmpdir(), 'rebind-capture-')) })
after(() => rmSync(root, { recursive: true, force: true }))

const bytes = (n, fill = 7) => new Uint8Array(n).fill(fill)

async function seed(label, steps = 1, media = 0) {
  const session = newSession({ label })
  for (let i = 0; i < steps; i++) {
    const entry = addStep(session, { width: 100, height: 100, bytes: 32 })
    await writeAsset(root, session.id, entry.file, bytes(32, i + 1))
    await writeAsset(root, session.id, entry.thumb, bytes(8, i + 1))
  }
  for (let i = 0; i < media; i++) {
    const entry = addMedia(session, { container: 'webm', bytes: 64 })
    await writeAsset(root, session.id, entry.file, bytes(64))
  }
  await saveSession(root, session)
  return session
}

describe('writing', () => {
  test('a write is atomic — no temp file survives it', async () => {
    const file = join(root, 'atomic', 'thing.json')
    await writeAtomic(file, '{"a":1}')
    assert.equal(await fs.readFile(file, 'utf8'), '{"a":1}')

    // The whole point: a crash mid-write leaves the old file or the new one,
    // never a half-written one, and never litter beside it.
    const left = await fs.readdir(join(root, 'atomic'))
    assert.deepEqual(left, ['thing.json'])
  })

  test('two writes in the same millisecond do not collide', async () => {
    const dir = join(root, 'race')
    await Promise.all([
      writeAtomic(join(dir, 'a.bin'), bytes(4, 1)),
      writeAtomic(join(dir, 'b.bin'), bytes(4, 2))
    ])
    const left = (await fs.readdir(dir)).sort()
    assert.deepEqual(left, ['a.bin', 'b.bin'])
  })
})

describe('sessions', () => {
  test('a saved session reads back as itself', async () => {
    const session = await seed('Round trip', 2)
    const back = await loadSession(root, session.id)
    assert.equal(back.id, session.id)
    assert.equal(back.label, 'Round trip')
    assert.equal(back.steps.length, 2)
    assert.equal(back.steps[1].file, 'step-002.png')
  })

  test('the listing is newest first and carries computed totals', async () => {
    const first = await seed('Older', 1)
    // Distinct timestamps, or the sort has nothing to sort by.
    await new Promise((r) => setTimeout(r, 12))
    const second = await seed('Newer', 3, 1)

    const list = await listSessions(root)
    const ids = list.map((s) => s.id)
    assert.ok(ids.indexOf(second.id) < ids.indexOf(first.id), 'newest should be first')

    const newer = list.find((s) => s.id === second.id)
    assert.equal(newer.steps, 3)
    assert.equal(newer.media, 1)
  })

  test('a directory that is not a session is skipped, not fatal', async () => {
    await fs.mkdir(join(root, 'not-a-session'), { recursive: true })
    await fs.writeFile(join(root, 'not-a-session', 'session.json'), 'this is not json')
    // One unreadable folder must not take the whole library down — the
    // alternative is an app that will not open.
    const list = await listSessions(root)
    assert.ok(list.length > 0)
    assert.ok(!list.some((s) => s.name === 'not-a-session'))
  })

  test('deleting takes the files with it', async () => {
    const session = await seed('Delete me', 2)
    await deleteSession(root, session.id)
    assert.equal(await loadSession(root, session.id), null)
    await assert.rejects(() => fs.stat(sessionDir(root, session.id)))
  })
})

describe('assets', () => {
  test('bytes go out and come back unchanged', async () => {
    const session = await seed('Assets', 0)
    const data = bytes(2048, 0xAB)
    const written = await writeAsset(root, session.id, 'step-001.png', data)
    assert.equal(written.bytes, 2048)
    const back = await readAsset(root, session.id, 'step-001.png')
    assert.equal(back.length, 2048)
    assert.equal(back[0], 0xAB)

    await removeAsset(root, session.id, 'step-001.png')
    await assert.rejects(() => readAsset(root, session.id, 'step-001.png'))
  })

  test('removing something already gone is not an error', async () => {
    const session = await seed('Gone', 0)
    await removeAsset(root, session.id, 'never-existed.png')
  })
})

describe('renumbering on disk', () => {
  test('shifting every file down by one does not destroy the one below', async () => {
    const session = await seed('Shift', 3)
    // Each step's bytes are filled with its own number, so a file that was
    // overwritten rather than moved is detectable.
    removeStep(session, session.steps[0].id)
    await removeAsset(root, session.id, 'step-001.png')
    await removeAsset(root, session.id, 'step-001.thumb.png')

    const renames = renumber(session)
    await applyRenames(root, session.id, renames)
    await saveSession(root, session)

    // Step 2 became step 1 and step 3 became step 2 — a direct rename would
    // have had step 3 overwrite step 2 before step 2 had moved.
    const one = await readAsset(root, session.id, 'step-001.png')
    const two = await readAsset(root, session.id, 'step-002.png')
    assert.equal(one[0], 2, 'the old step 2 should now be step 1')
    assert.equal(two[0], 3, 'the old step 3 should now be step 2')

    const left = await fs.readdir(sessionDir(root, session.id))
    assert.ok(!left.some((f) => f.includes('.renaming')), 'no staging files left behind')
    assert.ok(!left.includes('step-003.png'), 'the vacated slot should be gone')
  })

  test('a rename of a file that is missing is survivable', async () => {
    const session = await seed('Partial', 2)
    await removeAsset(root, session.id, 'step-002.thumb.png')
    const renames = [{ from: 'step-002.thumb.png', to: 'step-001.thumb.png' }]
    // The index no longer references it either way; failing the whole renumber
    // over one absent thumbnail would be worse than skipping it.
    assert.equal(await applyRenames(root, session.id, renames), 0)
  })
})

describe('housekeeping', () => {
  test('library size counts what is actually on disk', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'rebind-capture-size-'))
    try {
      const session = newSession({ label: 'Sized' })
      await saveSession(fresh, session)
      await writeAsset(fresh, session.id, 'a.png', bytes(1000))
      await writeAsset(fresh, session.id, 'b.png', bytes(2000))
      const total = await libraryBytes(fresh)
      // The two assets plus the index, so strictly more than the assets alone.
      assert.ok(total > 3000, `expected more than 3000 bytes, got ${total}`)
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  test('empty sessions are cleared and populated ones are not', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'rebind-capture-prune-'))
    try {
      await saveSession(fresh, newSession({ label: 'Empty one' }))
      await saveSession(fresh, newSession({ label: 'Empty two' }))
      const kept = newSession({ label: 'Has a step' })
      addStep(kept, { bytes: 10 })
      await saveSession(fresh, kept)

      assert.equal(await pruneEmpty(fresh), 2)
      const left = await listSessions(fresh)
      assert.equal(left.length, 1)
      assert.equal(left[0].id, kept.id)
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  test('files the index has lost track of are reported, not deleted', async () => {
    const session = await seed('Orphans', 1)
    await writeAsset(root, session.id, 'step-009.png', bytes(10))

    const found = await orphans(root, session.id)
    assert.deepEqual(found, ['step-009.png'])
    // Reported, not removed: in an evidence tool the orphan may be the only
    // copy of something that mattered.
    await readAsset(root, session.id, 'step-009.png')
  })

  test('the copy kept for undo is not an orphan', async () => {
    const session = await seed('Undo copies', 1)
    const step = session.steps[0]
    await writeAsset(root, session.id, originalName(step.file), bytes(32))

    assert.deepEqual(await orphans(root, session.id), [],
      'reporting the undo copy as a stray file would invite deleting it')
    assert.equal(originalName('step-004.png'), 'step-004.orig.png')
  })
})

describe('verifying a session against itself', () => {
  test('an untouched session is intact', async () => {
    const session = await seed('Intact', 2, 1)
    for (const step of session.steps) {
      step.sha256 = await hashAsset(root, session.id, step.file)
    }
    for (const item of session.media) {
      item.sha256 = await hashAsset(root, session.id, item.file)
    }
    await saveSession(root, session)

    const result = await verifySession(root, session.id)
    assert.equal(result.intact, true, JSON.stringify(result))
    assert.equal(result.checked, 3)
  })

  test('a file edited in place is caught', async () => {
    // What this is actually for: another program touching the file, a sync
    // client resolving a conflict badly, a half-restored backup.
    const session = await seed('Tampered', 2)
    for (const step of session.steps) {
      step.sha256 = await hashAsset(root, session.id, step.file)
    }
    await saveSession(root, session)

    await writeAsset(root, session.id, session.steps[1].file, bytes(32, 99))

    const result = await verifySession(root, session.id)
    assert.equal(result.intact, false)
    assert.deepEqual(result.modified, ['step-002.png'])
    assert.deepEqual(result.ok, ['step-001.png'])
  })

  test('a deleted file is missing, not modified', async () => {
    const session = await seed('Gone', 2)
    for (const step of session.steps) {
      step.sha256 = await hashAsset(root, session.id, step.file)
    }
    await saveSession(root, session)
    await removeAsset(root, session.id, session.steps[0].file)

    const result = await verifySession(root, session.id)
    assert.deepEqual(result.missing, ['step-001.png'])
    assert.deepEqual(result.modified, [])
  })

  test('a session captured before hashing existed is unverified, not broken', async () => {
    const session = await seed('Legacy', 2)
    const result = await verifySession(root, session.id)

    assert.equal(result.intact, false)
    assert.equal(result.unverified.length, 2)
    assert.deepEqual(result.modified, [], 'no digest is not the same as a wrong digest')
  })

  test('the undo copies are not part of the check', async () => {
    // They are working files, not evidence: they are in no export, and a
    // missing one means "cannot revert", not "something is wrong".
    const session = await seed('Undo', 1)
    session.steps[0].sha256 = await hashAsset(root, session.id, session.steps[0].file)
    await saveSession(root, session)
    await writeAsset(root, session.id, originalName(session.steps[0].file), bytes(32, 3))

    const result = await verifySession(root, session.id)
    assert.equal(result.intact, true)
    assert.equal(result.checked, 1)
  })

  test('a session that is not there verifies as nothing rather than throwing', async () => {
    assert.equal(await verifySession(root, 's-nope-nope'), null)
  })
})
