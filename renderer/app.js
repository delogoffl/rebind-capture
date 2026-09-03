/**
 * The shell: state, routing, and the things every view needs.
 *
 * Unlike the browser extension this app grew out of, the renderer here is
 * long-lived — it is the window, and it is not destroyed the moment the user
 * looks somewhere else. So it can own the session, and it does. Main takes the
 * screenshots and writes the files; this decides what a capture means, what it
 * is called, and which session it belongs to. One writer, so the index and the
 * files on disk cannot disagree.
 */

import { $, all, el, icon, toast, mmss, humanBytes, thumbnail, markCursor, burnKeys } from './ui.js'
import { newSession, addStep, addMedia, summarise } from '../lib/session.js'
import { describe as describeKey, fold, expire } from '../lib/keys.js'
import { mountCapture } from './view-capture.js'
import { mountRecord } from './view-record.js'
import { mountLibrary } from './view-library.js'
import { mountSettings } from './view-settings.js'

const api = window.capture

/* ────────────────────────────────────────────────────────────────── state */

export const state = {
  info: null,
  settings: null,
  /** The session captures land in. Created lazily, on the first capture. */
  session: null,
  /** 'ready' | 'busy' | 'recording' | 'paused' | 'saving' */
  phase: 'ready',
  recording: { startedAt: 0, pausedMs: 0, pausedAt: 0 },
  sessions: [],
  view: 'capture',
  /**
   * The keypress strip, mirrored here.
   *
   * The overlay window owns what is drawn on screen, but two other things need
   * the same strip: a screenshot burns it into the PNG, and a recording draws
   * it into every frame. Both are in this renderer and both need it *now* —
   * thirty times a second in the recorder's case — so it is folded here from
   * the same events rather than fetched from main across IPC.
   */
  keys: []
}

const listeners = new Set()
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export function changed() { for (const fn of [...listeners]) fn(state) }

/** Recorded time, not wall-clock time: a pause must not inflate the number. */
export function elapsed() {
  const { startedAt, pausedMs, pausedAt } = state.recording
  if (!startedAt) return 0
  const paused = pausedMs + (pausedAt ? Date.now() - pausedAt : 0)
  return Math.max(0, Date.now() - startedAt - paused)
}

export function setPhase(phase) {
  state.phase = phase
  paintStatus()
  changed()
}

/* ────────────────────────────────────────────────────────────── sessions */

/**
 * The session a capture belongs to, made on demand.
 *
 * Not on launch: a session created every time the app opens leaves a trail of
 * empty folders for every run where nothing was captured. The first capture is
 * the first moment there is anything to belong to one.
 */
export async function ensureSession(label = '') {
  if (state.session) return state.session
  state.session = newSession({ label })
  await api.library.save(state.session)
  await refreshSessions()
  paintSession()
  return state.session
}

/**
 * Forget the current session, because it is no longer on disk.
 *
 * Clearing `state.session` alone is not enough — the rail's card is painted
 * from it, so deleting the open session left its name and its step count
 * sitting in the sidebar pointing at a folder that had gone. The next capture
 * then starts a fresh session, which is right, but the UI said otherwise until
 * something else happened to repaint.
 */
export async function forgetSession(id) {
  if (id && state.session?.id !== id) return false
  state.session = null
  await refreshSessions()
  paintSession()
  changed()
  return true
}

export async function startNewSession() {
  state.session = null
  await ensureSession()
  toast('New session started')
  changed()
}

async function persist() {
  if (!state.session) return
  await api.library.save(state.session)
  await refreshSessions()
  paintSession()
  changed()
}

/**
 * Everything in the library, not just the screenshots.
 *
 * This counted `steps` alone, so a library holding nothing but recordings —
 * which is what an afternoon of testing the recorder produces — showed zero
 * next to a Library tab with four videos in it. The badge is on the word
 * "Library", so it has to mean everything the library holds.
 */
const libraryCount = (sessions) =>
  sessions.reduce((n, s) => n + (s.steps || 0) + (s.media || 0), 0)

export async function refreshSessions() {
  state.sessions = await api.library.list()
  $('navCount').textContent = String(libraryCount(state.sessions))
  return state.sessions
}

/* ───────────────────────────────────────────────────────────── capturing */

/**
 * Everything a capture goes through between the shutter and the library.
 *
 * The cursor ring is burnt into the pixels here rather than kept as an
 * annotation, because a marker that only exists in this app's viewer is not
 * evidence — the PNG that gets attached to a ticket has to carry it.
 */
export async function storeShot(shot) {
  const settings = state.settings
  const session = await ensureSession()

  let png = shot.png
  if (settings.markCursor && shot.cursor) {
    png = await markCursor(png, shot.cursor, {
      color: CURSOR_COLORS[settings.cursorColor] || CURSOR_COLORS.cyan,
      size: settings.cursorSize
    })
  }
  // The keys go in after the ring, so a cap over the pointer wins — the cap is
  // the thing that was just done, the ring is where it was done.
  if (settings.keypress) png = await burnKeys(png, shot.keys || state.keys, settings)

  const entry = addStep(session, {
    title: titleFor(shot, session),
    mode: shot.mode,
    width: shot.width,
    height: shot.height,
    bytes: png.byteLength,
    capturedAt: Date.now(),
    cursor: shot.cursor,
    source: shot.source,
    meta: settings.metadata ? shot.meta : null
  })

  // The full-size PNG and the grid's copy, written together — a step whose
  // thumbnail is missing renders as a blank tile, which reads as data loss.
  await api.library.writeAsset({ sessionId: session.id, name: entry.file, data: png })
  await api.library.writeAsset({
    sessionId: session.id,
    name: entry.thumb,
    data: await thumbnail(png, 480)
  })

  if (settings.copyToClipboard) await api.shot.copy(png)
  if (settings.sound) shutter()

  await persist()
  return entry
}

const CURSOR_COLORS = {
  cyan: '#06B6D4', indigo: '#6366F1', amber: '#F59E0B', red: '#F43F5E', green: '#10B981'
}

/** The window or display it came from, which is what people search for later. */
function titleFor(shot, session) {
  const name = shot.source?.name?.trim()
  const index = session.steps.length + 1
  if (!name) return `Step ${index}`
  return name.length > 64 ? `${name.slice(0, 63)}…` : name
}

/**
 * A shutter, synthesised.
 *
 * Two hundred bytes of WebAudio rather than an audio file: a short noise burst
 * through a decaying envelope is what a shutter is, and shipping a .wav for it
 * would be the only binary asset in the app that is not the icon.
 */
let audio = null
function shutter() {
  try {
    audio = audio || new AudioContext()
    const now = audio.currentTime
    const length = Math.floor(audio.sampleRate * 0.06)
    const buffer = audio.createBuffer(1, length, audio.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < length; i++) {
      // Noise under a sharp exponential decay: the click, then the tail.
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (length * 0.18))
    }
    const source = audio.createBufferSource()
    source.buffer = buffer
    const gain = audio.createGain()
    gain.gain.setValueAtTime(0.16, now)
    const filter = audio.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 2600
    source.connect(filter).connect(gain).connect(audio.destination)
    source.start(now)
  } catch {
    // No audio device, or the context was blocked. A silent shutter is not a
    // reason to fail a capture.
  }
}

export async function storeRecording({ blob, container, mimeType, width, height, durationMs, source, audio: tracks }) {
  const session = await ensureSession()
  const entry = addMedia(session, {
    container, mimeType, width, height, durationMs,
    bytes: blob.size,
    startedAt: state.recording.startedAt || Date.now(),
    source,
    audio: tracks
  })
  await api.library.writeAsset({
    sessionId: session.id,
    name: entry.file,
    data: new Uint8Array(await blob.arrayBuffer())
  })
  await persist()
  return entry
}

/* ─────────────────────────────────────────────────────────────── painting */

const PHASE_TEXT = {
  ready: 'Ready', busy: 'Working…', recording: 'REC', paused: 'Paused', saving: 'Saving…'
}

let ticker = 0

function paintStatus() {
  const pill = $('statusPill')
  const text = $('statusText')
  const phase = state.phase
  pill.dataset.phase = phase

  clearInterval(ticker)
  if (phase === 'recording') {
    const paint = () => { text.textContent = `REC  ${mmss(elapsed())}` }
    paint()
    ticker = setInterval(paint, 500)
  } else if (phase === 'paused') {
    text.textContent = `Paused  ${mmss(elapsed())}`
  } else {
    text.textContent = PHASE_TEXT[phase] || 'Ready'
  }
}

function paintSession() {
  const session = state.session
  const name = session ? (session.label || session.name) : 'No session yet'
  $('sessionName').textContent = name
  // The title bar carries the open document, which is what a title bar is for.
  $('tbTitle').textContent = session ? name : ''

  if (!session) {
    $('sessionFacts').textContent = 'Capture something to start one'
    return
  }
  const sum = summarise(session)
  $('sessionFacts').textContent =
    `${sum.steps} step${sum.steps === 1 ? '' : 's'} · ${sum.media} rec · ${humanBytes(sum.bytes)}`
}

export function applyTheme() {
  const root = document.documentElement
  const theme = state.settings.theme === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : state.settings.theme
  root.dataset.theme = theme
  root.dataset.accent = state.settings.accent
}

/* ──────────────────────────────────────────────────────────────── routing */

const VIEWS = {
  capture: mountCapture,
  record: mountRecord,
  library: mountLibrary,
  settings: mountSettings
}

const mounted = new Map()

export function go(name) {
  if (!VIEWS[name]) return
  state.view = name

  for (const node of all('.nav')) {
    node.setAttribute('aria-current', String(node.dataset.view === name))
  }

  const stage = $('stage')
  for (const [key, view] of mounted) view.root.hidden = key !== name

  if (!mounted.has(name)) {
    const root = el('section.view', { dataset: { view: name } })
    stage.append(root)
    const view = VIEWS[name]({ root, api, state })
    mounted.set(name, { root, ...view })
  }
  mounted.get(name).enter?.()
  changed()
}

/** Views ask for a repaint after something they do not own has changed. */
export function refreshView(name) {
  const view = mounted.get(name || state.view)
  view?.enter?.()
}

/* ────────────────────────────────────────────────────────────────── boot */

async function boot() {
  state.info = await api.app.info()
  // Whether the input hook loaded here is a platform fact the settings panel
  // needs, so it can explain itself rather than offering a switch that silently
  // does nothing.
  state.info.keys = await api.keys.available()
  state.settings = await api.settings.read()
  applyTheme()

  await refreshSessions()
  paintStatus()
  paintSession()

  const stats = await api.library.stats()
  $('statusLibrary').textContent = `${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'} · ${humanBytes(stats.bytes)}`

  for (const node of all('.nav')) {
    node.addEventListener('click', () => go(node.dataset.view))
  }

  $('winMin').addEventListener('click', () => api.window.minimize())
  $('winMax').addEventListener('click', () => api.window.maximize())
  $('winClose').addEventListener('click', () => api.window.close())
  $('newSession').addEventListener('click', () => startNewSession())
  $('revealSession').addEventListener('click', () => api.library.reveal(state.session?.id))
  $('openLibraryFolder').addEventListener('click', () => api.library.reveal(null))

  api.settings.onChanged((next) => {
    state.settings = next
    applyTheme()
    changed()
  })

  /**
   * A capture that started outside the app.
   *
   * The global hotkey fires in main, which takes the picture and sends it here
   * — the renderer is the only writer of the library, so main never stores
   * anything itself.
   */
  api.shot.onTaken(async (shot) => {
    try {
      setPhase('busy')
      const entry = await storeShot(shot)
      toast(`Step ${entry.index} captured`, {
        action: 'Library',
        onAction: () => go('library')
      })
    } catch (err) {
      toast(String(err?.message || err), { tone: 'bad' })
    } finally {
      setPhase('ready')
    }
  })

  /**
   * Mirror the strip locally, using the same reducer the overlay uses.
   *
   * Same module, same folding, same expiry — so what is burnt into a capture
   * cannot disagree with what the user was looking at when they took it.
   */
  api.keys.onDown((event) => {
    if (!state.settings.keypress) return
    const hold = Math.max(500, Number(state.settings.keypressHold) * 1000 || 2500)
    const pressed = describeKey(event, { mask: state.settings.keypressMask })
    if (!pressed) return
    state.keys = fold(expire(state.keys, hold), pressed)
  })

  // Swept on a timer as well as on a press, or the last caps of a burst would
  // sit in the mirror until the next key — and land in a capture taken after
  // they had faded from the screen.
  setInterval(() => {
    if (!state.keys.length) return
    const hold = Math.max(500, Number(state.settings.keypressHold) * 1000 || 2500)
    const left = expire(state.keys, hold)
    if (left.length !== state.keys.length) state.keys = left
  }, 250)

  api.shot.onFailed(({ message }) => toast(message, { tone: 'bad' }))

  // The hook refused to start, so main turned the setting back off rather than
  // leaving a switch on that claims something untrue.
  api.keys.onUnavailable(({ reason }) => {
    toast(`Keypress display is unavailable — ${reason}`, { tone: 'warn', timeout: 7000 })
  })

  const paintHotkeyStatus = ({ failed }) => {
    $('statusHotkeys').textContent = failed.length
      ? `${failed.length} shortcut${failed.length === 1 ? '' : 's'} already in use`
      : 'Shortcuts active'
    if (failed.length) {
      toast(`${failed.length} shortcut${failed.length === 1 ? ' is' : 's are'} taken by another app`, {
        tone: 'warn', action: 'Settings', onAction: () => go('settings')
      })
    }
  }
  api.hotkeys.onState(paintHotkeyStatus)
  // Bound before this window existed, so the first report was pushed to nobody.
  paintHotkeyStatus(await api.hotkeys.read())

  api.window.onState(({ maximized }) => {
    $('winMax').title = maximized ? 'Restore' : 'Maximise'
  })

  go('capture')

  // Number keys jump between views. A four-view app does not need a command
  // palette, and 1–4 is what people already try.
  addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea, select')) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const index = ['1', '2', '3', '4'].indexOf(event.key)
    if (index >= 0) go(Object.keys(VIEWS)[index])
  })
}

boot().catch((err) => {
  document.body.append(el('div.note.bad', { style: { margin: '20px' } }, [
    icon('alert'),
    el('span', { text: `Rebind Capture could not start: ${err?.message || err}` })
  ]))
})
