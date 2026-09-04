/**
 * Turning a recording into steps.
 *
 * All of the ways this feature fails are arithmetic, and all of them are in
 * here rather than in the video element: a step on the wrong frame, a step
 * inside a pause where nothing was recorded, forty steps for one sentence
 * typed into one field, or a plan whose last entry seeks past the end of the
 * file and yields the same frame three times under different captions.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { planSteps, foldMarks, offsetOf, pausedBefore, describePlan, DEFAULTS } from '../lib/marks.js'

const T0 = 1_700_000_000_000
const click = (ms, extra = {}) => ({ at: T0 + ms, kind: 'click', x: 10, y: 20, button: 1, ...extra })
const key = (ms, extra = {}) => ({ at: T0 + ms, kind: 'key', ...extra })

const take = (durationMs, pauses = []) => ({ startedAt: T0, durationMs, pauses })

describe('where a moment sits in the video', () => {
  test('with no pauses it is simply the elapsed time', () => {
    assert.equal(offsetOf(T0 + 5000, { startedAt: T0 }), 5000)
  })

  test('paused time is subtracted, because the video does not contain it', () => {
    // Ten seconds in, after a four-second pause, is six seconds of video.
    const pauses = [{ from: T0 + 2000, to: T0 + 6000 }]
    assert.equal(offsetOf(T0 + 10_000, { startedAt: T0, pauses }), 6000)
    assert.equal(pausedBefore(T0 + 10_000, pauses), 4000)
  })

  test('several pauses accumulate', () => {
    const pauses = [{ from: T0 + 1000, to: T0 + 2000 }, { from: T0 + 5000, to: T0 + 8000 }]
    assert.equal(offsetOf(T0 + 10_000, { startedAt: T0, pauses }), 6000)
  })

  test('a moment inside a pause has no frame at all', () => {
    // Nothing was recorded then. Pretending otherwise produces a step showing
    // whatever was on screen when recording resumed.
    const pauses = [{ from: T0 + 2000, to: T0 + 6000 }]
    assert.equal(offsetOf(T0 + 4000, { startedAt: T0, pauses }), null)
  })

  test('a pause still running is treated as running until now', () => {
    const pauses = [{ from: T0 + 2000 }]
    assert.equal(offsetOf(T0 + 4000, { startedAt: T0, pauses }), null)
    assert.equal(pausedBefore(T0 + 5000, pauses), 3000)
  })

  test('a moment before the recording began is not in it', () => {
    assert.equal(offsetOf(T0 - 1, { startedAt: T0 }), null)
  })
})

describe('folding a raw stream into actions', () => {
  test('a burst of typing is one action, not forty', () => {
    const marks = []
    for (let i = 0; i < 40; i++) marks.push(key(1000 + i * 60))
    const folded = foldMarks(marks)

    assert.equal(folded.length, 1)
    assert.equal(folded[0].kind, 'type')
    assert.equal(folded[0].count, 40)
    assert.equal(folded[0].label, 'Typed 40 keys')
  })

  test('a run is timestamped where the typing ended', () => {
    // The useful frame shows the filled field, not the empty one.
    const folded = foldMarks([key(1000), key(1100), key(1200)])
    assert.equal(folded[0].at, T0 + 1200)
  })

  test('two separate bursts are two actions', () => {
    const folded = foldMarks([key(1000), key(1100), key(9000), key(9100)])
    assert.equal(folded.length, 2)
    assert.deepEqual(folded.map((f) => f.count), [2, 2])
  })

  test('a named key is an action in its own right', () => {
    // "Pressed Enter" reads as a step; folded into the typing before it, it
    // disappears from the document entirely.
    const folded = foldMarks([key(1000), key(1100), key(1200, { name: 'Enter' })])
    assert.deepEqual(folded.map((f) => f.kind), ['type', 'key'])
    assert.equal(folded[1].label, 'Pressed Enter')
  })

  test('a click closes an open run', () => {
    const folded = foldMarks([key(1000), key(1100), click(1400)])
    assert.deepEqual(folded.map((f) => f.kind), ['type', 'click'])
  })

  test('a right-click says so', () => {
    assert.equal(foldMarks([click(1000, { button: 2 })])[0].label, 'Right-clicked')
  })

  test('events out of order are sorted, not trusted', () => {
    const folded = foldMarks([click(5000), click(1000)])
    assert.deepEqual(folded.map((f) => f.at - T0), [1000, 5000])
  })

  test('junk in the stream is ignored', () => {
    assert.deepEqual(foldMarks([null, undefined, { kind: 'click' }]), [])
  })

  test('clicks-only drops typing entirely', () => {
    // For documenting how to navigate an interface, a typing run is a state
    // change with no location on screen and is often just noise.
    const folded = foldMarks(
      [click(1000), key(2000), key(2100), key(3000, { name: 'Enter' })],
      { clicksOnly: true }
    )
    assert.deepEqual(folded.map((f) => f.kind), ['click'])
  })
})

describe('planning the extraction', () => {
  test('a frame is taken just before the click, not at it', () => {
    // At the instant of a click the menu is already closing and the button is
    // mid-press; a moment earlier is the frame that shows what was clicked.
    const [step] = planSteps([click(5000)], take(20_000))
    assert.equal(step.offsetMs, 5000 - DEFAULTS.lead)
  })

  test('a click after a pause lands on the right frame', () => {
    // The bug this exists to prevent: every step after the first pause on the
    // wrong frame, which reads as the feature simply not working.
    const pauses = [{ from: T0 + 2000, to: T0 + 7000 }]
    const [step] = planSteps([click(10_000)], take(20_000, pauses))
    assert.equal(step.offsetMs, 5000 - DEFAULTS.lead)
  })

  test('a click inside a pause produces no step', () => {
    const pauses = [{ from: T0 + 2000, to: T0 + 7000 }]
    assert.deepEqual(planSteps([click(4000)], take(20_000, pauses)), [])
  })

  test('the click that started the take is not a step', () => {
    assert.deepEqual(planSteps([click(100)], take(20_000)), [])
  })

  test('a click after the last frame is not a step', () => {
    // The hook outlives the recorder by a moment — the stop click itself
    // arrives after the final frame. Seeking past the duration yields the last
    // frame over and over, the same picture under different captions.
    assert.deepEqual(planSteps([click(20_400)], take(20_000)), [])
    // And one that lands inside the recording is kept, so the guard is a guard
    // and not an off-by-one that drops the final real step.
    assert.equal(planSteps([click(19_900)], take(20_000)).length, 1)
  })

  test('a double click is one step', () => {
    const plan = planSteps([click(5000), click(5090)], take(20_000))
    assert.equal(plan.length, 1)
  })

  test('steps are numbered in order', () => {
    const plan = planSteps([click(2000), click(5000), click(9000)], take(20_000))
    assert.deepEqual(plan.map((p) => p.index), [1, 2, 3])
    assert.ok(plan[0].offsetMs < plan[1].offsetMs)
  })

  test('the click point is kept, so a marker can be drawn where it happened', () => {
    const [step] = planSteps([click(5000, { x: 640, y: 480 })], take(20_000))
    assert.equal(step.x, 640)
    assert.equal(step.y, 480)
  })

  test('every step carries a caption a person would write', () => {
    const plan = planSteps([click(2000), key(6000), key(6100), key(9000, { name: 'Enter' })], take(20_000))
    assert.deepEqual(plan.map((p) => p.label), ['Clicked', 'Typed 2 keys', 'Pressed Enter'])
  })

  test('a recording with no marks plans nothing, rather than failing', () => {
    assert.deepEqual(planSteps([], take(20_000)), [])
    assert.deepEqual(planSteps([click(1000)], {}), [])
    assert.deepEqual(planSteps([click(1000)], take(0)), [])
  })
})

describe('the ceiling', () => {
  test('a long session does not become a document with hundreds of steps', () => {
    const marks = []
    for (let i = 0; i < 400; i++) marks.push(click(1000 + i * 2000))
    const plan = planSteps(marks, take(900_000))

    assert.equal(plan.length, DEFAULTS.max)
    assert.deepEqual(plan.map((p) => p.index), plan.map((_, i) => i + 1))
  })

  test('the sample spans the whole recording rather than its first minute', () => {
    // The first sixty clicks of a long session are its opening minute, which is
    // the least representative part of it.
    const marks = []
    for (let i = 0; i < 400; i++) marks.push(click(1000 + i * 2000))
    const plan = planSteps(marks, take(900_000))

    const last = plan[plan.length - 1]
    assert.ok(last.offsetMs > 700_000, `last step at ${last.offsetMs}ms of a 900s take`)
  })
})

describe('telling the user what they will get', () => {
  test('the sentence names the actions, not the count alone', () => {
    const plan = planSteps([click(2000), click(5000), key(9000), key(9100)], take(20_000))
    assert.equal(describePlan(plan), '3 steps — 2 clicks, 1 typing run')
  })

  test('nothing recorded is said plainly', () => {
    assert.equal(describePlan([]), 'No actions were recorded')
  })
})
