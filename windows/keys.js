/**
 * The keypress overlay.
 *
 * Raw events come down from main, `lib/keys.js` decides what they mean, and
 * this draws the result. All the rules — naming, masking, folding a run of
 * typing into one growing cap, expiry — live in that module, tested, and none
 * of them are duplicated here. This file is the part that has a DOM.
 *
 * It also reports the current strip back up to main after every change, so the
 * capture path can draw the same caps into the image. Pushing rather than being
 * asked matters: the shutter hides this window first, and a request that
 * arrived after the hide would find nothing.
 */

import { describe, fold, expire, metrics, place, THEMES } from '../lib/keys.js'

const api = window.capture
const strip = document.getElementById('strip')

let settings = {
  keypressPosition: 'bl', keypressSize: 'md', keypressTheme: 'dark',
  keypressHold: 2.5, keypressMask: false
}
let caps = []
let sweeper = 0

/* ────────────────────────────────────────────────────────────────── look */

function applyLook() {
  const m = metrics(settings.keypressSize)
  const theme = THEMES[settings.keypressTheme] || THEMES.dark
  const s = document.documentElement.style

  s.setProperty('--h', `${m.height}px`)
  // The type scales with the cap but not linearly — a 56px cap with 28px text
  // reads as a poster rather than as a keyboard.
  s.setProperty('--font', `${m.font.toFixed(1)}px`)
  s.setProperty('--pad', `${m.padding.toFixed(1)}px`)
  s.setProperty('--radius', `${m.radius.toFixed(1)}px`)
  s.setProperty('--gap', `${m.gap.toFixed(1)}px`)
  s.setProperty('--bg', theme.bg)
  s.setProperty('--fg', theme.fg)
  s.setProperty('--edge', theme.edge)

  position()
}

/**
 * Put the strip in its corner.
 *
 * Measured rather than assumed, because the strip's width is whatever the caps
 * currently on it add up to — and a right-hand corner has to know that width to
 * sit against the edge. `place()` is the same function the burn-in uses, so the
 * live HUD and the captured one cannot disagree about where the corner is.
 */
function position() {
  const frame = { width: innerWidth, height: innerHeight }
  const box = strip.getBoundingClientRect()
  const at = place(settings.keypressPosition, frame, {
    width: box.width || 0,
    height: box.height || 0
  })
  strip.style.left = `${at.x}px`
  strip.style.top = `${at.y}px`
  strip.classList.toggle('top', String(settings.keypressPosition).startsWith('t'))
}

/* ───────────────────────────────────────────────────────────────── paint */

function paint() {
  const known = new Map([...strip.children].map((node) => [node.dataset.id, node]))

  for (const cap of caps) {
    const existing = known.get(cap.id)
    if (existing) {
      // Growing a run in place, so the cap does not re-animate on every letter.
      if (existing.textContent !== cap.text) existing.textContent = cap.text
      known.delete(cap.id)
      continue
    }
    const node = document.createElement('span')
    node.className = 'cap'
    node.dataset.id = cap.id
    node.textContent = cap.text
    strip.append(node)
  }

  // Anything left in the map has expired.
  for (const node of known.values()) {
    node.classList.add('going')
    node.addEventListener('transitionend', () => node.remove(), { once: true })
    // A transition that never fires — reduced motion, a hidden window — would
    // otherwise leave the node forever.
    setTimeout(() => node.remove(), 400)
  }

  position()
  // Main holds this so the capture path can draw the same caps into the image.
  api.keys.report(caps.map((cap) => ({ id: cap.id, text: cap.text, plain: cap.plain })))
}

/** One timer, not one per cap: eight timers to expire eight caps is wasteful. */
function sweep() {
  clearInterval(sweeper)
  sweeper = setInterval(() => {
    if (!caps.length) return
    const left = expire(caps, holdMs())
    if (left.length !== caps.length) { caps = left; paint() }
  }, 200)
}

const holdMs = () => Math.max(500, Number(settings.keypressHold) * 1000 || 2500)

/* ─────────────────────────────────────────────────────────────── wiring */

api.keys.onConfig((next) => {
  settings = { ...settings, ...next }
  applyLook()
})

api.keys.onDown((event) => {
  const pressed = describe(event, { mask: settings.keypressMask })
  if (!pressed) return
  caps = fold(expire(caps, holdMs()), pressed)
  paint()
})

addEventListener('resize', position)

applyLook()
sweep()
