/**
 * The keypress HUD's rules, as data and pure functions.
 *
 * No hook, no window, no DOM. `main.cjs` feeds it raw uiohook events and the
 * overlay renders whatever comes back, which is what makes the interesting
 * parts testable: what a keycode is called, when a run of typing collapses into
 * one growing cap, and — the part that matters most — what masking does and
 * does not hide.
 *
 * Masking is not a nicety. A tool that draws every keystroke into a screenshot
 * will eventually draw somebody's password into one, and the person holding the
 * screenshot afterwards is not necessarily the person who took it. Masking
 * keeps the evidence that typing happened, and its length, without the content;
 * modifiers and named keys still show, because those are the part a reader
 * needs in order to follow what was done.
 */

/**
 * uiohook keycodes to the label a person would recognise.
 *
 * Keyed by number rather than by uiohook's name export, so this module has no
 * dependency on the native package and runs anywhere. The numbers come from
 * `UiohookKey`, which is a stable table — it is the Linux input event set that
 * libuiohook normalises every platform onto.
 */
export const KEYS = {
  1: 'Esc', 14: '⌫', 15: '⇥', 28: '⏎', 57: 'Space', 58: 'Caps',
  3639: 'PrtSc', 69: 'NumLk', 70: 'ScrLk',
  3655: 'Home', 3657: 'PgUp', 3663: 'End', 3665: 'PgDn',
  3653: 'Del', 3666: 'Ins',
  57416: '↑', 57424: '↓', 57419: '←', 57421: '→',
  // Arrows and navigation report two different sets depending on platform.
  61000: '↑', 61008: '↓', 61003: '←', 61005: '→',
  3657: 'PgUp', 3665: 'PgDn', 3655: 'Home', 3663: 'End',

  29: 'Ctrl', 3613: 'Ctrl', 56: 'Alt', 3640: 'Alt',
  42: 'Shift', 54: 'Shift', 3675: 'Meta', 3676: 'Meta',

  59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6',
  65: 'F7', 66: 'F8', 67: 'F9', 68: 'F10', 87: 'F11', 88: 'F12'
}

/** Printable keys, so a run of them can collapse into one growing cap. */
export const CHARS = {
  2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0',
  16: 'Q', 17: 'W', 18: 'E', 19: 'R', 20: 'T', 21: 'Y', 22: 'U', 23: 'I', 24: 'O', 25: 'P',
  30: 'A', 31: 'S', 32: 'D', 33: 'F', 34: 'G', 35: 'H', 36: 'J', 37: 'K', 38: 'L',
  44: 'Z', 45: 'X', 46: 'C', 47: 'V', 48: 'B', 49: 'N', 50: 'M',
  39: ';', 13: '=', 51: ',', 12: '-', 52: '.', 53: '/', 41: '`',
  26: '[', 43: '\\', 27: ']', 40: "'"
}

/** The four that are a chord's prefix, never its subject. */
const MODIFIER_CODES = new Set([29, 3613, 56, 3640, 42, 54, 3675, 3676])

export const isModifier = (keycode) => MODIFIER_CODES.has(keycode)

/**
 * One raw event to one displayable press, or null.
 *
 * Null for a bare modifier: `Shift` on its own is not something anyone means to
 * record, and showing it turns every capitalised letter into two caps.
 */
export function describe(event, { mask = false } = {}) {
  const { keycode } = event
  if (isModifier(keycode)) return null

  const mods = []
  if (event.ctrlKey) mods.push('Ctrl')
  if (event.metaKey) mods.push('Meta')
  if (event.altKey) mods.push('Alt')

  const char = CHARS[keycode]
  const named = KEYS[keycode]

  // Shift is only worth showing on a named key. On a letter it is already
  // expressed by the letter being a capital, and on a chord it is noise.
  if (event.shiftKey && !char) mods.push('Shift')

  if (char) {
    // A plain character is only "typing" when nothing else is held. With a
    // modifier it is a command, and commands never collapse into a run.
    const plain = mods.length === 0
    const label = plain && mask ? '•' : char
    return { plain, label: [...mods, label].join(' '), text: label }
  }

  if (named) return { plain: false, label: [...mods, named].join(' '), text: named }

  // An unmapped key is still evidence that a key was pressed, and a keycode is
  // more useful to whoever reads the report than nothing at all.
  return { plain: false, label: [...mods, `#${keycode}`].join(' '), text: `#${keycode}` }
}

export const MAX_CAPS = 8
export const MAX_RUN = 24

/**
 * Fold a press into the caps already on screen.
 *
 * Typing into a field should read as typing rather than as a wall of single
 * letters, so a run of plain characters grows one cap instead of adding eight.
 * The run breaks on anything that is not plain, and at `MAX_RUN` characters so
 * one long paragraph cannot push everything else off the strip.
 *
 * Returns a new array — the caller holds the state, which keeps this pure and
 * makes the whole thing a reducer a test can drive one press at a time.
 */
export function fold(caps, press, now = Date.now()) {
  if (!press) return caps
  const last = caps[caps.length - 1]

  if (press.plain && last?.plain && last.text.length < MAX_RUN) {
    const grown = { ...last, text: last.text + press.text, at: now }
    return [...caps.slice(0, -1), grown]
  }

  const next = [...caps, { id: `${now}-${caps.length}`, plain: press.plain, text: press.label, at: now }]
  return next.length > MAX_CAPS ? next.slice(next.length - MAX_CAPS) : next
}

/** Drop anything older than the hold time. */
export function expire(caps, holdMs, now = Date.now()) {
  return caps.filter((cap) => now - cap.at < holdMs)
}

/* ─────────────────────────────────────────────────────────────── geometry */

export const SIZES = { sm: 26, md: 34, lg: 44, xl: 56 }

export const THEMES = {
  dark: { bg: 'rgba(14, 18, 30, .92)', fg: '#F3F5FA', edge: 'rgba(255, 255, 255, .22)' },
  light: { bg: 'rgba(255, 255, 255, .94)', fg: '#0A1020', edge: 'rgba(11, 18, 32, .16)' },
  accent: { bg: 'rgba(99, 102, 241, .94)', fg: '#FFFFFF', edge: 'rgba(255, 255, 255, .3)' }
}

export const CORNERS = ['tl', 'tc', 'tr', 'bl', 'bc', 'br']

/**
 * Where the strip sits inside a frame, in pixels.
 *
 * Shared by the live overlay and by the code that burns the caps into a
 * capture, so the preview and the evidence cannot disagree about the corner.
 * `margin` scales with the frame: a fixed 24px inset is generous on a 1280px
 * screenshot and hairline on a 4K one.
 */
export function place(corner, frame, strip) {
  const margin = Math.round(Math.min(frame.width, frame.height) * 0.022)
  const code = CORNERS.includes(corner) ? corner : 'bl'

  const x = code.endsWith('l') ? margin
    : code.endsWith('r') ? frame.width - strip.width - margin
      : Math.round((frame.width - strip.width) / 2)

  const y = code.startsWith('t') ? margin : frame.height - strip.height - margin
  return { x: Math.max(0, x), y: Math.max(0, y) }
}

/** Cap metrics derived from one size, so the two renderers stay in step. */
export function metrics(size, scale = 1) {
  const h = (SIZES[size] || SIZES.md) * scale
  return {
    height: h,
    font: h * 0.42,
    padding: h * 0.32,
    radius: h * 0.24,
    gap: Math.max(3, h * 0.16),
    minWidth: h
  }
}
