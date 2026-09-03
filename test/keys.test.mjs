/**
 * The keypress HUD's rules.
 *
 * Pure functions fed raw uiohook-shaped events, so none of this needs the
 * native hook, a window or a display. The masking tests are the ones that
 * matter: this feature draws what somebody typed into a file that gets attached
 * to tickets, and the person reading that file later is not necessarily the
 * person who took it.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  describe as label, fold, expire, isModifier, place, metrics, MAX_CAPS, MAX_RUN, SIZES, CORNERS
} from '../lib/keys.js'

/** uiohook's event shape, with the modifier flags defaulted off. */
const press = (keycode, mods = {}) => ({
  keycode, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods
})

const A = 30, S = 31, D = 32, F = 33
const ENTER = 28, ESC = 1, TAB = 15, SHIFT = 42, CTRL = 29

describe('naming a key', () => {
  test('a letter is its letter', () => {
    assert.equal(label(press(A)).text, 'A')
    assert.equal(label(press(A)).plain, true)
  })

  test('a bare modifier is not a press worth showing', () => {
    // Otherwise every capital letter renders as two caps, and holding Ctrl to
    // scroll fills the strip with nothing.
    assert.equal(label(press(SHIFT)), null)
    assert.equal(label(press(CTRL)), null)
    assert.ok(isModifier(SHIFT) && isModifier(CTRL))
  })

  test('a chord reads as a chord and never as typing', () => {
    const chord = label(press(S, { ctrlKey: true }))
    assert.equal(chord.label, 'Ctrl S')
    assert.equal(chord.plain, false, 'a command must not fold into a run of typing')
  })

  test('Shift shows on a named key and not on a letter', () => {
    // On a letter it is already expressed by the letter being a capital.
    assert.equal(label(press(A, { shiftKey: true })).label, 'A')
    assert.equal(label(press(TAB, { shiftKey: true })).label, 'Shift ⇥')
  })

  test('named keys use the glyph people recognise', () => {
    assert.equal(label(press(ENTER)).text, '⏎')
    assert.equal(label(press(ESC)).text, 'Esc')
    assert.equal(label(press(57)).text, 'Space')
  })

  test('an unmapped key still records that something was pressed', () => {
    // Silence would be a gap in the evidence; a keycode is at least a fact.
    assert.match(label(press(9999)).text, /^#9999$/)
  })
})

describe('masking', () => {
  const masked = (code, mods) => label(press(code, mods), { mask: true })

  test('a typed character becomes a dot', () => {
    assert.equal(masked(A).text, '•')
    assert.equal(masked(A).plain, true, 'a masked character is still typing')
  })

  test('a password does not survive masking', () => {
    let caps = []
    for (const code of [33, 32, A, S, D, 30]) caps = fold(caps, masked(code), 1000)
    const shown = caps.map((c) => c.text).join('')
    assert.equal(shown, '••••••', `expected six dots, got ${shown}`)
    assert.ok(!/[A-Z]/.test(shown), 'no letter may reach the strip')
  })

  test('the length of what was typed is still visible', () => {
    // That is the evidence: somebody typed eight characters into this field.
    let caps = []
    for (let i = 0; i < 8; i++) caps = fold(caps, masked(A), 1000)
    assert.equal(caps[0].text.length, 8)
  })

  test('named keys and modifiers are never masked', () => {
    // They carry no secret and they are what makes the run readable.
    assert.equal(masked(ENTER).text, '⏎')
    assert.equal(masked(TAB).text, '⇥')
    assert.equal(masked(S, { ctrlKey: true }).label, 'Ctrl S')
  })

  test('masking off shows the characters', () => {
    assert.equal(label(press(A), { mask: false }).text, 'A')
  })
})

describe('folding presses into caps', () => {
  test('a run of typing grows one cap rather than adding many', () => {
    let caps = []
    for (const code of [A, S, D, F]) caps = fold(caps, label(press(code)), 1000)
    assert.equal(caps.length, 1)
    assert.equal(caps[0].text, 'ASDF')
  })

  test('a command breaks the run', () => {
    let caps = fold([], label(press(A)), 1000)
    caps = fold(caps, label(press(S, { ctrlKey: true })), 1001)
    caps = fold(caps, label(press(D)), 1002)
    assert.deepEqual(caps.map((c) => c.text), ['A', 'Ctrl S', 'D'])
  })

  test('a long run breaks rather than growing without limit', () => {
    let caps = []
    for (let i = 0; i < MAX_RUN + 6; i++) caps = fold(caps, label(press(A)), 1000 + i)
    assert.ok(caps.length > 1, 'one paragraph must not become one cap')
    assert.ok(caps.every((c) => c.text.length <= MAX_RUN))
  })

  test('the strip keeps the newest and drops the oldest', () => {
    let caps = []
    for (let i = 0; i < MAX_CAPS + 4; i++) caps = fold(caps, label(press(ENTER)), 1000 + i)
    assert.equal(caps.length, MAX_CAPS)
  })

  test('a null press changes nothing', () => {
    const caps = [{ id: 'x', plain: false, text: 'Esc', at: 1000 }]
    assert.equal(fold(caps, null, 2000), caps)
  })
})

describe('expiry', () => {
  test('caps older than the hold time go, newer ones stay', () => {
    const caps = [
      { id: 'a', text: 'A', at: 1000 },
      { id: 'b', text: 'B', at: 4000 }
    ]
    const left = expire(caps, 2000, 5000)
    assert.deepEqual(left.map((c) => c.id), ['b'])
  })

  test('nothing expires before its time', () => {
    const caps = [{ id: 'a', text: 'A', at: 1000 }]
    assert.equal(expire(caps, 2000, 2500).length, 1)
  })
})

describe('placement', () => {
  const frame = { width: 1920, height: 1080 }
  const strip = { width: 300, height: 40 }

  test('every corner lands in the half it names', () => {
    for (const corner of CORNERS) {
      const at = place(corner, frame, strip)
      const top = corner.startsWith('t')
      assert.equal(at.y < frame.height / 2, top, `${corner} vertical`)
      if (corner.endsWith('l')) assert.ok(at.x < frame.width / 3, `${corner} left`)
      if (corner.endsWith('r')) assert.ok(at.x + strip.width > (frame.width * 2) / 3, `${corner} right`)
      if (corner.endsWith('c')) {
        const centre = at.x + strip.width / 2
        assert.ok(Math.abs(centre - frame.width / 2) < 2, `${corner} centred`)
      }
    }
  })

  test('the strip never leaves the frame', () => {
    for (const corner of CORNERS) {
      const at = place(corner, frame, strip)
      assert.ok(at.x >= 0 && at.y >= 0)
      assert.ok(at.x + strip.width <= frame.width)
      assert.ok(at.y + strip.height <= frame.height)
    }
  })

  test('a strip wider than the frame is clamped rather than pushed off', () => {
    const at = place('br', { width: 200, height: 200 }, { width: 400, height: 40 })
    assert.equal(at.x, 0)
  })

  test('an unknown corner falls back rather than producing NaN', () => {
    const at = place('nowhere', frame, strip)
    assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y))
  })

  test('the inset scales with the frame', () => {
    // A fixed 24px is generous on a 1280px shot and hairline on a 4K one.
    const small = place('tl', { width: 1280, height: 720 }, strip)
    const large = place('tl', { width: 3840, height: 2160 }, strip)
    assert.ok(large.x > small.x)
  })
})

describe('metrics', () => {
  test('every size is distinct and ordered', () => {
    const heights = Object.keys(SIZES).map((s) => metrics(s).height)
    assert.deepEqual(heights, [...heights].sort((a, b) => a - b))
    assert.equal(new Set(heights).size, heights.length)
  })

  test('type scales with the cap but not linearly', () => {
    // A 56px cap with 28px text reads as a poster rather than a keyboard.
    const small = metrics('sm')
    const huge = metrics('xl')
    assert.ok(huge.font > small.font)
    assert.ok(huge.font / huge.height - small.font / small.height < 0.001)
  })

  test('scale multiplies everything together', () => {
    // The burn-in draws at the image's scale; the overlay draws at 1.
    const one = metrics('md', 1)
    const two = metrics('md', 2)
    assert.equal(two.height, one.height * 2)
    assert.equal(two.font, one.font * 2)
  })

  test('an unknown size falls back to medium', () => {
    assert.equal(metrics('enormous').height, SIZES.md)
  })
})
