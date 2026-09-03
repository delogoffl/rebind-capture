/**
 * The session model.
 *
 * Pure functions, so these are ordinary unit tests — no Electron, no window,
 * no filesystem. That split is the reason `lib/` exists at all: the rules about
 * what a step number means are worth testing on their own, and they are
 * untestable once they are tangled up in a renderer.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  newSession, addStep, addMedia, renumber, removeStep, removeMedia,
  summarise, reviveSession, slug
} from '../lib/session.js'

const shot = (over = {}) => ({ width: 1920, height: 1080, bytes: 1000, mode: 'screen', ...over })

describe('naming', () => {
  test('a slug is safe on every filesystem and still readable', () => {
    assert.equal(slug('My Report: Q3 (final)'), 'my-report-q3-final')
    assert.equal(slug('  spaces  '), 'spaces')
    // Windows forbids these outright, and a trailing dot makes a file that
    // cannot be created at all.
    assert.equal(slug('a<b>c:d"e/f\\g|h?i*j'), 'a-b-c-d-e-f-g-h-i-j')
    assert.equal(slug('trailing...'), 'trailing')
    assert.ok(!slug('....').includes('.'))
    // Never empty: an empty name would collide with the directory itself.
    assert.equal(slug(''), 'session')
    assert.equal(slug(null), 'session')
    assert.ok(slug('x'.repeat(200)).length <= 48)
  })

  test('a session is named date-first, so a folder listing sorts itself', () => {
    const at = new Date('2026-03-09T14:22:06').getTime()
    const session = newSession({ label: 'Checkout bug', when: at })
    assert.match(session.name, /^20260309-142206-checkout-bug$/)
    assert.equal(session.label, 'Checkout bug')
    assert.equal(session.steps.length, 0)
  })
})

describe('adding to a session', () => {
  test('steps are numbered in order and named to match', () => {
    const session = newSession()
    const a = addStep(session, shot())
    const b = addStep(session, shot())

    assert.equal(a.index, 1)
    assert.equal(b.index, 2)
    assert.equal(a.file, 'step-001.png')
    assert.equal(b.thumb, 'step-002.thumb.png')
    assert.notEqual(a.id, b.id)
  })

  test('a deleted step does not let the next capture reuse its number', () => {
    const session = newSession()
    addStep(session, shot())
    const second = addStep(session, shot())
    addStep(session, shot())

    removeStep(session, second.id)
    const fourth = addStep(session, shot())

    // Three steps remain (1, 3) plus the new one. The new one must not be "3"
    // as well — two files called step-003.png is data loss, silently.
    assert.deepEqual(session.steps.map((s) => s.index), [1, 3, 3])
    assert.equal(fourth.file, 'step-003.png')
    // Which is exactly why renumber exists and is called after a delete.
    renumber(session)
    assert.deepEqual(session.steps.map((s) => s.index), [1, 2, 3])
    assert.deepEqual(session.steps.map((s) => s.file), ['step-001.png', 'step-002.png', 'step-003.png'])
  })

  test('renumbering reports the renames rather than performing them', () => {
    const session = newSession()
    const a = addStep(session, shot())
    const b = addStep(session, shot())
    const c = addStep(session, shot())
    removeStep(session, a.id)

    const renames = renumber(session)
    // Two files per step, and only the steps that actually moved.
    assert.equal(renames.length, 4)
    assert.deepEqual(renames[0], { from: 'step-002.png', to: 'step-001.png' })
    assert.equal(b.index, 1)
    assert.equal(c.index, 2)
    // The module never touches the disk, which is what makes it testable here.
    assert.ok(renames.every((r) => typeof r.from === 'string' && typeof r.to === 'string'))
  })

  test('renumbering rewrites default titles and leaves real ones alone', () => {
    const session = newSession()
    const a = addStep(session, shot())
    addStep(session, shot())
    session.steps[1].title = 'Pressed Pay now'
    removeStep(session, a.id)
    renumber(session)

    // A title the user wrote is theirs; one we generated tracked the number and
    // would otherwise say "Step 2" on step 1.
    assert.equal(session.steps[0].title, 'Pressed Pay now')

    const other = newSession()
    addStep(other, shot())
    const second = addStep(other, shot())
    removeStep(other, other.steps[0].id)
    renumber(other)
    assert.equal(second.title, 'Step 1')
  })

  test('recordings are numbered and extensioned separately from steps', () => {
    const session = newSession()
    addStep(session, shot())
    const rec = addMedia(session, { container: 'mp4', durationMs: 4000, bytes: 90 })
    assert.equal(rec.file, 'rec-01.mp4')
    assert.equal(rec.index, 1)
    assert.equal(addMedia(session, { container: 'webm' }).file, 'rec-02.webm')
    assert.equal(removeMedia(session, rec.id).id, rec.id)
    assert.equal(session.media.length, 1)
  })
})

describe('summaries', () => {
  test('totals are computed, so they cannot drift from the contents', () => {
    const session = newSession({ label: 'Run' })
    addStep(session, shot({ bytes: 1500 }))
    addStep(session, shot({ bytes: 2500 }))
    addMedia(session, { bytes: 6000, durationMs: 12_000 })

    const sum = summarise(session)
    assert.equal(sum.steps, 2)
    assert.equal(sum.media, 1)
    assert.equal(sum.bytes, 10_000)
    assert.equal(sum.duration, 12_000)
    assert.equal(sum.empty, false)
  })

  test('a session with nothing in it is flagged, so it can be cleared', () => {
    assert.equal(summarise(newSession()).empty, true)
  })
})

describe('reading a session back', () => {
  test('a hand-edited or half-written file cannot take the library down', () => {
    // Every one of these is something a real settings-adjacent JSON file has
    // been found to contain: missing arrays, wrong types, absent ids.
    const revived = reviveSession({
      id: 'sx',
      name: 'run',
      startedAt: 'not a number',
      steps: [{ file: 'step-001.png' }, null, { nope: true }],
      media: 'not an array'
    })

    assert.ok(revived)
    assert.equal(revived.steps.length, 1, 'entries without a file are not steps')
    assert.equal(revived.steps[0].index, 1)
    assert.equal(revived.steps[0].title, 'Step 1')
    assert.deepEqual(revived.steps[0].annotations, [])
    assert.deepEqual(revived.media, [])
    assert.ok(Number.isFinite(revived.startedAt))
  })

  test('nothing at all reads as nothing, not as a crash', () => {
    assert.equal(reviveSession(null), null)
    assert.equal(reviveSession('a string'), null)
  })

  test('a round trip through JSON is lossless', () => {
    const session = newSession({ label: 'Round trip' })
    addStep(session, shot({ cursor: { x: 10, y: 20 } }))
    addMedia(session, { container: 'mp4' })
    const back = reviveSession(JSON.parse(JSON.stringify(session)))
    assert.deepEqual(back.steps[0].cursor, { x: 10, y: 20 })
    assert.equal(back.name, session.name)
    assert.equal(back.media[0].file, session.media[0].file)
  })
})
