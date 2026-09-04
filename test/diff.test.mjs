/**
 * Finding what changed between two captures.
 *
 * The value of this feature is entirely in what it *doesn't* report. Boxing the
 * thing that actually changed is easy; not boxing the clock in the corner, the
 * blinking caret and the antialiasing on a redrawn label is the whole problem,
 * because a suggestion that is usually wrong costs more to dismiss than it
 * saves.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { diffRegions, scaleRegions, BLOCK, DEFAULTS } from '../lib/diff.js'

/** A blank RGBA image of one colour. */
function image(width, height, [r, g, b] = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
  }
  return data
}

/** Paint a solid rectangle into one. */
function fill(data, width, { x, y, width: w, height: h }, [r, g, b]) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * width + px) * 4
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
    }
  }
  return data
}

const SIZE = { width: 320, height: 240 }

describe('finding a change', () => {
  test('an identical pair reports nothing', () => {
    const a = image(SIZE.width, SIZE.height)
    const b = image(SIZE.width, SIZE.height)
    assert.deepEqual(diffRegions(a, b, SIZE), [])
  })

  test('a region that appeared is boxed', () => {
    const a = image(SIZE.width, SIZE.height)
    const b = fill(image(SIZE.width, SIZE.height), SIZE.width,
      { x: 80, y: 60, width: 64, height: 48 }, [20, 20, 200])

    const found = diffRegions(a, b, SIZE)
    assert.equal(found.length, 1)

    const [box] = found
    // Padded outwards by design, so the box does not clip its own subject.
    assert.ok(box.x <= 80 && box.y <= 60, JSON.stringify(box))
    assert.ok(box.x + box.width >= 144 && box.y + box.height >= 108, JSON.stringify(box))
    // But not wildly larger than what changed.
    assert.ok(box.width < 64 + 6 * BLOCK && box.height < 48 + 6 * BLOCK, JSON.stringify(box))
  })

  test('two separate changes are two boxes', () => {
    const a = image(SIZE.width, SIZE.height)
    const b = image(SIZE.width, SIZE.height)
    fill(b, SIZE.width, { x: 16, y: 16, width: 48, height: 40 }, [255, 0, 0])
    fill(b, SIZE.width, { x: 230, y: 170, width: 48, height: 40 }, [0, 255, 0])

    assert.equal(diffRegions(a, b, SIZE).length, 2)
  })

  test('a change in one channel only is still a change', () => {
    // A red error message appearing on grey — averaging the channels would
    // dilute exactly the case this is for.
    const a = image(SIZE.width, SIZE.height, [128, 128, 128])
    const b = fill(image(SIZE.width, SIZE.height, [128, 128, 128]), SIZE.width,
      { x: 40, y: 40, width: 64, height: 48 }, [200, 128, 128])
    assert.equal(diffRegions(a, b, SIZE).length, 1)
  })
})

describe('what it refuses to report', () => {
  test('a blinking caret is not a change', () => {
    // Two pixels wide and sixteen tall, which is below the noise floor.
    const a = image(SIZE.width, SIZE.height)
    const b = fill(image(SIZE.width, SIZE.height), SIZE.width,
      { x: 100, y: 100, width: 2, height: 16 }, [0, 0, 0])
    assert.deepEqual(diffRegions(a, b, SIZE), [])
  })

  test('faint noise below the threshold is not a change', () => {
    const a = image(SIZE.width, SIZE.height, [128, 128, 128])
    const b = fill(image(SIZE.width, SIZE.height, [128, 128, 128]), SIZE.width,
      { x: 40, y: 40, width: 80, height: 60 }, [136, 136, 136])
    assert.deepEqual(diffRegions(a, b, SIZE), [],
      'an 8/255 shift is compression and rendering, not an edit')
  })

  test('"the whole screen changed" says nothing and is dropped', () => {
    const a = image(SIZE.width, SIZE.height, [255, 255, 255])
    const b = image(SIZE.width, SIZE.height, [0, 0, 0])
    assert.deepEqual(diffRegions(a, b, SIZE), [],
      'navigating to a different page should not box the entire capture')
  })

  test('images of different sizes are not comparable', () => {
    // A window resized between steps: guessing at an alignment would produce
    // confident nonsense, so it produces nothing.
    const a = image(320, 240)
    const b = image(640, 480)
    assert.deepEqual(diffRegions(a, b, { width: 320, height: 240 }), [])
    assert.deepEqual(diffRegions(a, b, { width: 640, height: 480 }), [])
  })

  test('missing input is survivable', () => {
    assert.deepEqual(diffRegions(null, null, SIZE), [])
    assert.deepEqual(diffRegions(image(8, 8), image(8, 8), { width: 0, height: 0 }), [])
  })
})

describe('grouping', () => {
  test('a changed sentence is one box, not one per word', () => {
    // Text leaves the spaces between words unchanged; without gap tolerance a
    // single edited line comes back as a dozen separate regions.
    const a = image(SIZE.width, SIZE.height)
    const b = image(SIZE.width, SIZE.height)
    for (let i = 0; i < 6; i++) {
      fill(b, SIZE.width, { x: 40 + i * 24, y: 100, width: 16, height: 14 }, [0, 0, 0])
    }
    const found = diffRegions(a, b, SIZE)
    assert.equal(found.length, 1, JSON.stringify(found))
    assert.ok(found[0].width > 130, 'and the box spans the whole line')
  })

  test('the biggest change comes first, and there is a ceiling', () => {
    const a = image(SIZE.width, SIZE.height)
    const b = image(SIZE.width, SIZE.height)
    fill(b, SIZE.width, { x: 10, y: 10, width: 24, height: 24 }, [255, 0, 0])
    fill(b, SIZE.width, { x: 200, y: 20, width: 80, height: 70 }, [0, 0, 255])

    const found = diffRegions(a, b, SIZE)
    assert.equal(found.length, 2)
    assert.ok(found[0].area > found[1].area, 'the main change should be the first suggestion')
    assert.ok(found.length <= DEFAULTS.limit)
  })
})

describe('moving a suggestion onto the full-size image', () => {
  test('a box found on a thumbnail lands on the same thing at full size', () => {
    const [box] = scaleRegions(
      [{ x: 40, y: 30, width: 80, height: 60, area: 0.0625 }],
      { width: 320, height: 240 },
      { width: 1920, height: 1440 }
    )
    assert.equal(box.x, 240)
    assert.equal(box.y, 180)
    assert.equal(box.width, 480)
    assert.equal(box.height, 360)
  })

  test('scaling never runs off the edge', () => {
    const [box] = scaleRegions(
      [{ x: 300, y: 220, width: 40, height: 40 }],
      { width: 320, height: 240 },
      { width: 640, height: 480 }
    )
    assert.ok(box.x + box.width <= 640)
    assert.ok(box.y + box.height <= 480)
  })

  test('nonsense in, nothing out', () => {
    assert.deepEqual(scaleRegions([{ x: 0, y: 0, width: 1, height: 1 }], null, { width: 10, height: 10 }), [])
  })
})
