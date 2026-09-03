/**
 * Settings: the defaults, the validation, and nothing else.
 *
 * Every value that comes back from disk goes through `mergeSettings`, which
 * keeps only what it recognises and clamps what it keeps. A settings file is a
 * plain JSON file in a directory the user can open, so it *will* be hand-edited
 * eventually, and a hand-edited file must not be able to put the app into a
 * state it cannot start from — a zero-length hotkey, a negative countdown, a
 * quality of `"high"` where a number belongs.
 */

export const DEFAULTS = Object.freeze({
  theme: 'dark',
  accent: 'indigo',

  /** 'screen' | 'window' | 'region' */
  captureMode: 'screen',
  /** Seconds before a capture fires, so a menu can be opened first. */
  countdown: 0,
  /** Draw a ring where the pointer was when the shot was taken. */
  markCursor: true,
  cursorColor: 'cyan',
  cursorSize: 'md',
  /** Hide the app's own window during a capture, so it is never in the shot. */
  hideOnCapture: true,
  /** Copy every capture to the clipboard as well as the library. */
  copyToClipboard: false,
  /** Play a shutter sound. */
  sound: true,

  /** 'screen' | 'window' */
  recordSource: 'screen',
  recordAudio: false,
  recordMic: false,
  /** Frames per second the recorder asks for. */
  fps: 30,
  /** Megabits per second. */
  bitrate: 8,
  /** Show the floating transport while recording. */
  recorderBar: true,
  /** Keep the transport out of the recording it controls. */
  protectBar: true,
  /**
   * Minimise the app when a recording starts.
   *
   * A recorder whose own window is still covering the thing you wanted to
   * record is not much of a recorder. The transport is a separate always-on-top
   * window, so it survives the minimise and stays reachable.
   */
  minimizeOnRecord: true,
  countIn: 3,

  /**
   * The keypress HUD.
   *
   * Drawn *into* the evidence, so where it sits and how big it is are not
   * cosmetic preferences — a HUD parked over the field being typed into ruins
   * the screenshot it was meant to explain, and one sized for a laptop is
   * unreadable in a 4K capture pasted into a ticket.
   */
  keypress: false,
  /**
   * When the keyboard is actually watched.
   *
   * 'recording' — the hook starts with a take and stops with it. This is the
   * default because a global input hook running for the whole time the app
   * happens to be open is not something anyone should have to take on trust,
   * and it is not what "show my keypresses in the recording" asks for.
   *
   * 'always' — watched whenever the feature is on, which is what puts keys into
   * screenshots as well as recordings.
   */
  keypressWhen: 'recording',
  /** 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br' */
  keypressPosition: 'bl',
  /** 'sm' | 'md' | 'lg' | 'xl' */
  keypressSize: 'md',
  /** 'dark' | 'light' | 'accent' */
  keypressTheme: 'dark',
  /** Seconds a cap stays before it fades. */
  keypressHold: 2.5,
  /**
   * Print typed characters as dots.
   *
   * A tool that draws every keystroke into a screenshot will eventually draw
   * somebody's password into one, and whoever reads that file later is not
   * necessarily whoever took it. Masking keeps the evidence that typing
   * happened, and its length, without the content.
   */
  keypressMask: false,

  metadata: true,
  exportFormat: 'pdf',
  includeMeta: true,

  hotkeys: {
    captureScreen: 'CommandOrControl+Shift+1',
    captureWindow: 'CommandOrControl+Shift+2',
    captureRegion: 'CommandOrControl+Shift+3',
    toggleRecording: 'CommandOrControl+Shift+R',
    pauseRecording: 'CommandOrControl+Shift+P'
  }
})

const ENUMS = {
  keypressWhen: ['recording', 'always'],
  keypressPosition: ['tl', 'tc', 'tr', 'bl', 'bc', 'br'],
  keypressSize: ['sm', 'md', 'lg', 'xl'],
  keypressTheme: ['dark', 'light', 'accent'],
  theme: ['dark', 'light', 'system'],
  accent: ['indigo', 'cyan', 'violet', 'emerald', 'amber', 'rose'],
  captureMode: ['screen', 'window', 'region'],
  cursorColor: ['cyan', 'indigo', 'amber', 'red', 'green'],
  cursorSize: ['sm', 'md', 'lg'],
  recordSource: ['screen', 'window'],
  exportFormat: ['pdf', 'png', 'md', 'video']
}

const RANGES = {
  keypressHold: [0.5, 10],
  countdown: [0, 10],
  countIn: [0, 10],
  fps: [10, 60],
  bitrate: [1, 40]
}

const clamp = (n, [lo, hi], fallback) => {
  const value = Number(n)
  return Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback
}

/**
 * An accelerator Electron will actually accept.
 *
 * `globalShortcut.register` throws on a malformed string rather than returning
 * false, and a throw during startup is a window that never opens — so the
 * shape is checked here and anything unrecognised falls back to the default.
 * This is not the full Electron grammar; it is the subset this app binds, which
 * is the subset a rebinding UI can produce.
 */
const MODIFIERS = new Set([
  'Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl',
  'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'
])

const KEY = /^(?:[0-9A-Za-z]|F[1-9]|F1[0-9]|F2[0-4]|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|PrintScreen|~|!|@|#|\$|%|\^|&|\*|\(|\)|_|=|\[|]|\\|;|'|,|\.|\/)$/

export function isAccelerator(text) {
  if (typeof text !== 'string' || !text.trim()) return false
  const parts = text.split('+')
  const key = parts.pop()
  if (!KEY.test(key)) return false
  if (!parts.length) return false
  if (new Set(parts).size !== parts.length) return false
  return parts.every((part) => MODIFIERS.has(part))
}

/**
 * Two actions on one chord is a binding the user cannot reason about.
 *
 * Electron registers the first and silently refuses the second, so without this
 * check the symptom is "one of my shortcuts randomly stopped working".
 */
export function conflicts(hotkeys) {
  const seen = new Map()
  const clashes = []
  for (const [action, combo] of Object.entries(hotkeys || {})) {
    const key = String(combo).toLowerCase()
    if (seen.has(key)) clashes.push({ combo, actions: [seen.get(key), action] })
    else seen.set(key, action)
  }
  return clashes
}

export function mergeSettings(stored) {
  const out = { ...DEFAULTS, hotkeys: { ...DEFAULTS.hotkeys } }
  if (!stored || typeof stored !== 'object') return out

  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (key === 'hotkeys') continue
    const value = stored[key]
    if (value === undefined) continue

    if (ENUMS[key]) {
      if (ENUMS[key].includes(value)) out[key] = value
    } else if (RANGES[key]) {
      out[key] = clamp(value, RANGES[key], fallback)
    } else if (typeof fallback === 'boolean') {
      out[key] = Boolean(value)
    } else if (typeof fallback === 'string' && typeof value === 'string') {
      out[key] = value
    }
  }

  const hotkeys = stored.hotkeys && typeof stored.hotkeys === 'object' ? stored.hotkeys : {}
  for (const action of Object.keys(DEFAULTS.hotkeys)) {
    const combo = hotkeys[action]
    // An unbound action is a legitimate choice, so an explicit empty string is
    // kept. Anything else that is not a valid accelerator is not.
    if (combo === '') out.hotkeys[action] = ''
    else if (isAccelerator(combo)) out.hotkeys[action] = combo
  }

  return out
}

/** How the accelerator should read to a person on this platform. */
export function prettyHotkey(combo, platform = process.platform) {
  if (!combo) return 'Not set'
  const mac = platform === 'darwin'
  return combo
    .replace(/CommandOrControl|CmdOrCtrl/g, mac ? '⌘' : 'Ctrl')
    .replace(/Command|Cmd/g, mac ? '⌘' : 'Win')
    .replace(/Control|Ctrl/g, mac ? '⌃' : 'Ctrl')
    .replace(/Alt|Option/g, mac ? '⌥' : 'Alt')
    .replace(/Shift/g, mac ? '⇧' : 'Shift')
    .replace(/Super|Meta/g, mac ? '⌘' : 'Win')
    .split('+')
    .join(mac ? '' : ' + ')
}
