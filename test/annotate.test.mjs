/**
 * The annotation model.
 *
 * The rules worth testing here are the ones that decide what ends up in an
 * exported evidence pack: that a mis-click does not become a counted redaction,
 * that a mark cannot claim to cover pixels outside the image, and that what
 * goes to disk carries none of the editor's live state.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  TYPES, TYPE_NAMES, COLORS, makeAnnotation, normaliseRect, clampToImage,
  isUsable, hitTest, moveBy, hasRedaction, countRedactions, countByType,
  describe as describeMarks, serialise, reviveAnnotation, renumberSteps,
  strokeWidth, MIN_SIZE
} from '../lib/annotate.js'

const rect = (x, y, width, height) => ({ x, y, width, height })

describe('the kinds of mark', () => {
  test('exactly one of them destroys what is underneath', () => {
    const destructive = TYPE_NAMES.filter((name) => TYPES[name].destructive)
    assert.deepEqual(destructive, ['redact'],
      'if a second destructive type appears the editor’s save path has to know about it')
  })

  test('an unknown type is refused rather than stored', () => {
    assert.throws(() => makeAnnotation('scribble', rect(0, 0, 10, 10)), /Unknown annotation type/)
  })
})

describe('drawing a rectangle', () => {
  test('dragging up and to the left is an ordinary way to draw a box', () => {
    // Negative width would otherwise have to be understood by every consumer.
    assert.deepEqual(normaliseRect(rect(100, 100, -40, -30)), rect(60, 70, 40, 30))
  })

  test('a normalised mark is what gets stored', () => {
    const mark = makeAnnotation('box', rect(100, 100, -40, -30))
    assert.equal(mark.x, 60)
    assert.equal(mark.width, 40)
  })

  test('an arrow remembers which end the drag started at', () => {
    // Corner to corner is not enough: it is the difference between pointing at
    // the button and pointing away from it.
    const mark = makeAnnotation('arrow', rect(200, 200, -150, -100))
    assert.equal(mark.fromX, 200)
    assert.equal(mark.fromY, 200)
    assert.equal(mark.toX, 50)
    assert.equal(mark.toY, 100)
  })

  test('an unknown colour falls back rather than reaching the canvas', () => {
    assert.equal(makeAnnotation('box', rect(0, 0, 20, 20), { color: 'chartreuse' }).color, 'red')
    assert.ok(Object.keys(COLORS).length <= 6, 'a large palette invites blending into the screenshot')
  })
})

describe('what is worth keeping', () => {
  test('a click with no drag is not an annotation', () => {
    // Otherwise a report counts three redactions where the user made one and
    // mis-clicked twice.
    assert.equal(isUsable(makeAnnotation('redact', rect(10, 10, 0, 0))), false)
    assert.equal(isUsable(makeAnnotation('box', rect(10, 10, 2, 2))), false)
    assert.equal(isUsable(makeAnnotation('box', rect(10, 10, MIN_SIZE, MIN_SIZE))), true)
  })

  test('an arrow is judged on its length, not its area', () => {
    // A long horizontal arrow has almost no bounding area and is perfectly valid.
    const flat = makeAnnotation('arrow', rect(0, 0, 400, 0))
    assert.equal(flat.height, 0)
    assert.equal(isUsable(flat), true)
  })

  test('nothing at all is not usable', () => {
    assert.equal(isUsable(null), false)
    assert.equal(isUsable({ type: 'nope', width: 100, height: 100 }), false)
  })
})

describe('staying inside the picture', () => {
  test('a box dragged past the edge is clipped, not rejected', () => {
    const clipped = clampToImage(makeAnnotation('box', rect(900, 500, 300, 300)), 1000, 600)
    assert.deepEqual(
      { x: clipped.x, y: clipped.y, width: clipped.width, height: clipped.height },
      rect(900, 500, 100, 100)
    )
  })

  test('an arrow’s endpoints are clamped too', () => {
    const mark = makeAnnotation('arrow', rect(-50, -50, 2000, 2000))
    const clipped = clampToImage(mark, 800, 600)
    assert.ok(clipped.fromX >= 0 && clipped.fromY >= 0)
    assert.ok(clipped.toX <= 800 && clipped.toY <= 600)
  })

  test('a mark entirely outside collapses to nothing and is dropped', () => {
    const clipped = clampToImage(makeAnnotation('box', rect(5000, 5000, 100, 100)), 800, 600)
    assert.equal(isUsable(clipped), false)
  })
})

describe('editing', () => {
  test('the topmost mark wins a click', () => {
    const under = makeAnnotation('box', rect(0, 0, 200, 200))
    const over = makeAnnotation('redact', rect(50, 50, 50, 50))
    assert.equal(hitTest([under, over], { x: 70, y: 70 }).id, over.id,
      'the most recently drawn mark is the one being worked on')
    assert.equal(hitTest([under, over], { x: 10, y: 10 }).id, under.id)
    assert.equal(hitTest([under, over], { x: 500, y: 500 }), null)
  })

  test('moving takes the arrow’s endpoints with it', () => {
    const moved = moveBy(makeAnnotation('arrow', rect(10, 10, 100, 100)), 5, -5)
    assert.equal(moved.x, 15)
    assert.equal(moved.fromX, 15)
    assert.equal(moved.toY, 105)
  })

  test('numbers renumber in the order they were placed', () => {
    const marks = renumberSteps([
      makeAnnotation('step', rect(0, 0, 40, 40)),
      makeAnnotation('box', rect(0, 0, 40, 40)),
      makeAnnotation('step', rect(0, 0, 40, 40))
    ])
    assert.deepEqual(marks.filter((m) => m.type === 'step').map((m) => m.number), [1, 2])
  })
})

describe('what the report counts', () => {
  const marks = [
    makeAnnotation('box', rect(0, 0, 40, 40)),
    makeAnnotation('redact', rect(0, 0, 40, 40)),
    makeAnnotation('redact', rect(0, 0, 40, 40))
  ]

  test('redactions are counted separately from everything else', () => {
    assert.equal(countRedactions(marks), 2)
    assert.equal(countByType(marks).box, 1)
    assert.equal(countByType(marks).arrow, 0, 'every type is present, so callers need no guard')
  })

  test('hasRedaction is the question the save path asks', () => {
    // It decides whether the untouched original is kept or destroyed, and that
    // cannot be revisited afterwards.
    assert.equal(hasRedaction(marks), true)
    assert.equal(hasRedaction([makeAnnotation('box', rect(0, 0, 40, 40))]), false)
    assert.equal(hasRedaction([]), false)
  })

  test('the description reads like a sentence', () => {
    assert.equal(describeMarks(marks), '1 box · 2 redactions')
    assert.equal(describeMarks([makeAnnotation('redact', rect(0, 0, 40, 40))]), '1 redaction')
    assert.equal(describeMarks([]), '')
  })
})

describe('crossing the disk', () => {
  test('editor state does not reach session.json', () => {
    const mark = { ...makeAnnotation('box', rect(10.6, 20.2, 30.9, 40.1)), selected: true, hover: true }
    const stored = serialise(mark)
    assert.equal(stored.selected, undefined)
    assert.equal(stored.hover, undefined)
    // Rounded, because an evidence pack should not carry sub-pixel noise.
    assert.deepEqual(
      { x: stored.x, y: stored.y, width: stored.width, height: stored.height },
      rect(11, 20, 31, 40)
    )
  })

  test('a round trip keeps what matters', () => {
    const mark = makeAnnotation('arrow', rect(10, 10, 100, 80), { color: 'cyan', weight: 'lg' })
    const back = reviveAnnotation(serialise(mark))
    assert.equal(back.type, 'arrow')
    assert.equal(back.color, 'cyan')
    assert.equal(back.weight, 'lg')
    assert.equal(back.toX, 110)
  })

  test('a malformed mark is dropped rather than drawn', () => {
    assert.equal(reviveAnnotation(null), null)
    assert.equal(reviveAnnotation({ type: 'lasers', x: 0, y: 0 }), null)
  })

  test('a hand-edited file cannot smuggle in a colour or a weight', () => {
    const back = reviveAnnotation({ type: 'box', x: 0, y: 0, width: 10, height: 10, color: 'javascript:', weight: '999' })
    assert.equal(back.color, 'red')
    assert.equal(back.weight, 'md')
  })
})

describe('how thick to draw', () => {
  test('a mark stays visible on a 4K capture and does not become a slab on a small one', () => {
    const big = strokeWidth('md', 3840, 2160)
    const small = strokeWidth('md', 400, 300)
    assert.ok(big > small, '2px on a 4K screenshot disappears once it is scaled into a PDF')
    assert.ok(small >= 2, 'and it can never round away to nothing')
    assert.ok(big <= 24, 'nor become a border thicker than the thing it surrounds')
  })
})
