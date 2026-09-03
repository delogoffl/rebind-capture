/**
 * The floating transport's whole behaviour.
 *
 * It owns nothing. Main pushes state in, the buttons send an action back to the
 * main window, and the main window — which holds the `MediaRecorder` — decides
 * what that means. A transport that kept its own idea of whether a recording
 * was running would be one more thing that can disagree with the recorder.
 *
 * The clock is the one exception: it ticks locally between pushes so it reads
 * smoothly at 500ms updates rather than stepping.
 */

const api = window.capture
const time = document.getElementById('time')
const pause = document.getElementById('pause')
const stop = document.getElementById('stop')
const shield = document.getElementById('shield')

const SVG = 'http://www.w3.org/2000/svg'

function glyph(paths, filled) {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', filled ? 'currentColor' : 'none')
  if (!filled) {
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2.2')
    svg.setAttribute('stroke-linecap', 'round')
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

const PAUSE = ['M9.3 5.6v12.8M14.7 5.6v12.8']
const PLAY = ['M8.5 5.4v13.2L19 12z']

const mmss = (ms) => {
  const total = Math.floor(Math.max(0, ms || 0) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

let state = { phase: 'recording', elapsedMs: 0, protect: false }
let from = Date.now()
let ticker = 0

function paint(next) {
  state = { ...state, ...next }
  document.body.dataset.phase = state.phase

  // Counting in: the transport is already up so the user can see where it is
  // and cancel, but there is no elapsed time yet and nothing to pause.
  if (state.phase === 'counting') {
    time.textContent = String(state.count ?? '')
    pause.hidden = true
    shield.hidden = !state.protect
    clearInterval(ticker)
    return
  }
  pause.hidden = false

  const paused = state.phase === 'paused'
  pause.replaceChildren(glyph(paused ? PLAY : PAUSE, paused))
  pause.title = paused ? 'Resume' : 'Pause'
  pause.setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording')
  shield.hidden = !state.protect

  // Anchored to the last push, so the local tick cannot drift away from the
  // recorder's own idea of how long it has been running.
  from = Date.now() - state.elapsedMs
  time.textContent = mmss(state.elapsedMs)

  clearInterval(ticker)
  if (!paused) {
    // While paused the number holds: it is recorded seconds, and none are being
    // recorded. A ticking clock over a paused take lies about the file's length.
    ticker = setInterval(() => { time.textContent = mmss(Date.now() - from) }, 250)
  }
}

api.bar.onState(paint)

pause.addEventListener('click', () => {
  api.bar.action(state.phase === 'paused' ? 'resume' : 'pause')
})
stop.addEventListener('click', () => api.bar.action('stop'))

// Escape does not stop a recording. Stopping is destructive-adjacent — it ends
// the take — and Escape is the key people press to dismiss things by reflex.
addEventListener('keydown', (event) => {
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault()
    pause.click()
  }
})
