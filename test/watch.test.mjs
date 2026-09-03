/**
 * The source watcher.
 *
 * The picker fetched its list once when the view opened, so closing an
 * application left its tile sitting there — and picking it produced a capture
 * failure some time later about a window that had been gone for minutes.
 *
 * There is no event for "another application closed a window", so the only way
 * to know is to ask again. Asking is not free — every enumeration walks each
 * window on the system and renders a thumbnail — so the rules about *when* it
 * asks are the part worth testing, and they are pure enough to test without a
 * browser.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The two globals `watch.js` touches, stubbed before it is imported.
 *
 * It reads `document.hidden` / `document.hasFocus()` to decide whether anybody
 * is looking, and registers a `focus` listener. Nothing else.
 */
let visible = true
let focused = true
const listeners = new Map()

globalThis.document = {
  get hidden() { return !visible }, hasFocus: () => focused
}
globalThis.addEventListener = (type, fn) => listeners.set(type, fn)
globalThis.removeEventListener = (type) => listeners.delete(type)

const { watchSources } = await import('../renderer/watch.js')

const tick = (ms) => new Promise((r) => setTimeout(r, ms))

/** A fake enumeration whose answer the test controls. */
function fakeSources(initial) {
  const box = { list: initial, calls: 0 }
  return {
    box,
    fetch: async () => { box.calls++; return box.list }
  }
}

const win = (id, name = id) => ({ id, name })

let watcher = null
beforeEach(() => { visible = true; focused = true })
after(() => { watcher?.stop() })

describe('when it asks', () => {
  test('it does not ask while nobody is looking', async () => {
    const { box, fetch } = fakeSources([win('a')])
    watcher = watchSources({ fetch, onChange: () => {}, every: 20 })
    watcher.start()

    visible = false
    await tick(90)
    assert.equal(box.calls, 0, 'a picker behind another window is not worth enumerating for')

    visible = true
    await tick(90)
    assert.ok(box.calls > 0, 'and it resumes when the view comes back')
    watcher.stop()
  })

  test('an unfocused window is left alone too', async () => {
    const { box, fetch } = fakeSources([win('a')])
    watcher = watchSources({ fetch, onChange: () => {}, every: 20 })
    watcher.start()
    focused = false
    await tick(90)
    assert.equal(box.calls, 0)
    watcher.stop()
  })

  test('stopping stops it', async () => {
    const { box, fetch } = fakeSources([win('a')])
    watcher = watchSources({ fetch, onChange: () => {}, every: 20 })
    watcher.start()
    await tick(60)
    const seen = box.calls
    watcher.stop()
    await tick(80)
    assert.equal(box.calls, seen, 'a stopped watcher must not keep enumerating')
  })
})

describe('what counts as a change', () => {
  test('an unchanged list repaints nothing', async () => {
    const { fetch } = fakeSources([win('a'), win('b')])
    let changes = 0
    watcher = watchSources({ fetch, onChange: () => { changes++ }, every: 15 })
    watcher.start()
    await tick(120)
    watcher.stop()
    // Several polls, no differences — repainting the grid each time would
    // reset hover and flicker every tile for nothing.
    assert.equal(changes, 0)
  })

  test('a window closing is a change', async () => {
    const { box, fetch } = fakeSources([win('a'), win('b')])
    let got = null
    watcher = watchSources({ fetch, onChange: (list) => { got = list }, every: 15 })
    watcher.start()
    await tick(60)

    box.list = [win('a')]
    await tick(80)
    watcher.stop()

    assert.ok(got, 'closing a window should repaint the picker')
    assert.deepEqual(got.map((s) => s.id), ['a'])
  })

  test('a window opening is a change', async () => {
    const { box, fetch } = fakeSources([win('a')])
    let got = null
    watcher = watchSources({ fetch, onChange: (list) => { got = list }, every: 15 })
    watcher.start()
    await tick(60)
    box.list = [win('a'), win('b')]
    await tick(80)
    watcher.stop()
    assert.deepEqual(got?.map((s) => s.id), ['a', 'b'])
  })

  test('a rename is a change, because the caption is what the user reads', async () => {
    const { box, fetch } = fakeSources([win('a', 'Untitled')])
    let got = null
    watcher = watchSources({ fetch, onChange: (list) => { got = list }, every: 15 })
    watcher.start()
    await tick(60)
    box.list = [win('a', 'report.docx')]
    await tick(80)
    watcher.stop()
    assert.equal(got?.[0].name, 'report.docx')
  })

  test('order alone is not a change', async () => {
    // Enumeration order is not stable, and repainting on it would mean
    // repainting constantly.
    const { box, fetch } = fakeSources([win('a'), win('b')])
    let changes = 0
    watcher = watchSources({ fetch, onChange: () => { changes++ }, every: 15 })
    watcher.start()
    await tick(60)
    box.list = [win('b'), win('a')]
    await tick(80)
    watcher.stop()
    assert.equal(changes, 0)
  })

  test('priming seeds the baseline without firing', async () => {
    // The view has just painted this list; reporting it as a change would
    // repaint it a second time on the first poll.
    const { fetch } = fakeSources([win('a')])
    let changes = 0
    watcher = watchSources({ fetch, onChange: () => { changes++ }, every: 15 })
    watcher.prime([win('a')])
    watcher.start()
    await tick(80)
    watcher.stop()
    assert.equal(changes, 0)
  })
})

describe('robustness', () => {
  test('a failed enumeration is survivable', async () => {
    let fail = true
    let changes = 0
    watcher = watchSources({
      fetch: async () => {
        if (fail) throw new Error('WGC said no')
        return [win('a')]
      },
      onChange: () => { changes++ },
      every: 15
    })
    watcher.start()
    await tick(60)
    fail = false
    await tick(80)
    watcher.stop()
    // The list on screen is still the last good answer, and the next poll is
    // seconds away — a throw here must not stop the watcher for good.
    assert.equal(changes, 0, 'the first success after a failure is the new baseline')
  })

  test('polls do not overlap', async () => {
    let inFlight = 0
    let overlapped = false
    watcher = watchSources({
      fetch: async () => {
        inFlight++
        if (inFlight > 1) overlapped = true
        await tick(60)
        inFlight--
        return [win('a')]
      },
      onChange: () => {},
      every: 10
    })
    watcher.start()
    await tick(200)
    watcher.stop()
    // On a slow machine a queue of enumerations would never catch up.
    assert.equal(overlapped, false)
  })
})
