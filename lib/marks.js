/**
 * Turning a recording into numbered steps.
 *
 * The app already records video and already runs a global input hook for the
 * keypress HUD. Those two halves have never been connected, and connecting them
 * is the whole feature: if you know the wall-clock time of every click, and you
 * have a video with a known start time, you can pull the frame at each click
 * and you have a step-by-step document out of one recording.
 *
 * This module is the arithmetic in between, kept pure so it can be tested
 * without a video element. It takes the raw stream the hook produced and
 * answers: which of these deserve a step, and at what offset into the video
 * does each one sit?
 *
 * Four rules do most of the work.
 *
 *   Pauses shift everything. The recording's timeline is wall-clock minus the
 *   time spent paused, so a click after a pause is *earlier* in the video than
 *   its timestamp suggests. Getting this wrong puts every step after the first
 *   pause on the wrong frame, which looks like the feature simply not working.
 *
 *   Frames are taken slightly *before* the click. At the instant of a click the
 *   menu is already closing and the button is mid-press; a moment earlier is
 *   the frame that shows what was about to be clicked, which is what a reader
 *   of the document needs to see.
 *
 *   Typing is one step, not forty. A burst of keystrokes into a field is one
 *   action a person took; a step per character is unusable.
 *
 *   There is a ceiling. A twenty-minute recording of ordinary work contains
 *   hundreds of clicks, and a document with hundreds of steps is not a document.
 */

/** What the hook reports, normalised. */
export const KINDS = Object.freeze(['click', 'type', 'key'])

export const DEFAULTS = Object.freeze({
  /**
   * How far before the event to take the frame, in milliseconds.
   *
   * Long enough to be before the press animation and the menu dismissal, short
   * enough that nothing else has happened. Measured against menus and buttons
   * rather than guessed.
   */
  lead: 160,
  /** Two events closer together than this are one action. */
  minGapMs: 550,
  /** A run of typing is closed when this long passes with no further key. */
  typingGapMs: 1200,
  /** Never produce more steps than this from one recording. */
  max: 60,
  /** Ignore anything in the first moments — the click that started the take. */
  settleMs: 350,
  /**
   * Clicks only, dropping typing and named keys.
   *
   * A click is a place on the screen and reads as "click here"; a typing run is
   * a state change with no location, and in a document about navigating an
   * interface it is often noise. Which is wanted depends on what is being
   * documented, so it is a setting rather than a judgement made here.
   */
  clicksOnly: false
})

/**
 * Total paused time before a given moment.
 *
 * `pauses` is a list of `{ from, to }` in wall-clock time; an open pause with no
 * `to` is one still running, which is clamped to the moment being asked about.
 */
export function pausedBefore(at, pauses = []) {
  let total = 0
  for (const pause of pauses) {
    if (!pause || typeof pause.from !== 'number') continue
    if (pause.from >= at) continue
    const to = typeof pause.to === 'number' ? pause.to : at
    total += Math.max(0, Math.min(to, at) - pause.from)
  }
  return total
}

/**
 * Where a wall-clock moment sits in the recorded video.
 *
 * Returns null for a moment that falls inside a pause: nothing was recorded
 * then, so there is no frame to extract and pretending otherwise would produce
 * a step showing whatever was on screen when recording resumed.
 */
export function offsetOf(at, { startedAt, pauses = [] } = {}) {
  if (!startedAt || at < startedAt) return null
  for (const pause of pauses) {
    if (!pause || typeof pause.from !== 'number') continue
    const to = typeof pause.to === 'number' ? pause.to : Infinity
    if (at > pause.from && at < to) return null
  }
  return at - startedAt - pausedBefore(at, pauses)
}

/**
 * Collapse a raw event stream into the actions worth a step.
 *
 * Keystrokes fold into runs; clicks stay as they are. The label is what the
 * step gets called, so it has to read like something a person did — "Clicked"
 * and "Typed 12 characters", not a keycode.
 */
export function foldMarks(marks = [], options = {}) {
  const { typingGapMs, clicksOnly } = { ...DEFAULTS, ...options }
  const sorted = [...marks]
    .filter((m) => m && typeof m.at === 'number')
    .filter((m) => !clicksOnly || m.kind === 'click')
    .sort((a, b) => a.at - b.at)

  const out = []
  let run = null

  const closeRun = () => {
    if (!run) return
    out.push({
      at: run.at,
      kind: 'type',
      count: run.count,
      label: run.count === 1 ? 'Typed a key' : `Typed ${run.count} keys`
    })
    run = null
  }

  for (const mark of sorted) {
    if (mark.kind === 'click') {
      closeRun()
      out.push({
        at: mark.at,
        kind: 'click',
        x: mark.x,
        y: mark.y,
        button: mark.button || 1,
        label: mark.button === 2 ? 'Right-clicked' : 'Clicked'
      })
      continue
    }

    // A named key on its own — Enter, Tab, Escape — is an action in its own
    // right and reads as one in a document, so it is not folded into a run.
    if (mark.kind === 'key' && mark.name) {
      closeRun()
      out.push({ at: mark.at, kind: 'key', name: mark.name, label: `Pressed ${mark.name}` })
      continue
    }

    if (!run || mark.at - run.last > typingGapMs) {
      closeRun()
      // The run is timestamped where the typing *ended*: the useful frame shows
      // the filled field, not the empty one.
      run = { at: mark.at, last: mark.at, count: 1 }
    } else {
      run.count++
      run.last = mark.at
      run.at = mark.at
    }
  }
  closeRun()
  return out
}

/**
 * The plan: which frames to pull out of a recording, and what to call them.
 *
 * @param {Array} marks  raw `{at, kind, x, y, name, button}` from the hook
 * @param {object} take  `{ startedAt, durationMs, pauses }`
 * @returns {Array<{offsetMs, at, kind, label, x, y, index}>}
 */
export function planSteps(marks = [], take = {}, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const { startedAt, durationMs = 0, pauses = [] } = take
  if (!startedAt || !durationMs) return []

  const folded = foldMarks(marks, opts)
  const planned = []
  let lastAt = -Infinity

  for (const mark of folded) {
    const offset = offsetOf(mark.at, { startedAt, pauses })
    if (offset === null) continue
    if (offset < opts.settleMs) continue

    // Back off to the frame before the action, but never past the start.
    const frameAt = Math.max(0, offset - opts.lead)
    // And never past the end: a click captured as the recorder was stopping has
    // no frame after it, and seeking beyond the duration yields the last frame
    // repeatedly — the same picture under three different captions.
    if (frameAt > durationMs - 40) continue

    if (mark.at - lastAt < opts.minGapMs) continue
    lastAt = mark.at

    planned.push({
      at: mark.at,
      offsetMs: frameAt,
      kind: mark.kind,
      label: mark.label,
      x: mark.x,
      y: mark.y
    })
  }

  // Over the ceiling, keep an even spread rather than the first N: the first
  // sixty clicks of a long session are its opening minute, which is the least
  // representative part of it.
  const kept = planned.length > opts.max ? thin(planned, opts.max) : planned
  return kept.map((mark, i) => ({ ...mark, index: i + 1 }))
}

/** Evenly spaced sample, always keeping the first and last. */
function thin(items, max) {
  if (items.length <= max) return items
  const out = []
  const stride = (items.length - 1) / (max - 1)
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * stride)])
  return [...new Set(out)]
}

/** A sentence for the button, so the user knows what they are about to get. */
export function describePlan(plan = []) {
  if (!plan.length) return 'No actions were recorded'
  const clicks = plan.filter((p) => p.kind === 'click').length
  const typed = plan.filter((p) => p.kind === 'type').length
  const keys = plan.filter((p) => p.kind === 'key').length
  const parts = []
  if (clicks) parts.push(`${clicks} click${clicks === 1 ? '' : 's'}`)
  if (typed) parts.push(`${typed} typing run${typed === 1 ? '' : 's'}`)
  if (keys) parts.push(`${keys} key press${keys === 1 ? '' : 'es'}`)
  return `${plan.length} step${plan.length === 1 ? '' : 's'} — ${parts.join(', ')}`
}
