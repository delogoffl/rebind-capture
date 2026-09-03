/**
 * The Record view, and the only place a `MediaRecorder` exists.
 *
 * Recording lives in the renderer for the same reason it lived in an offscreen
 * document in the browser extension: `MediaRecorder` needs a DOM, and the main
 * process does not have one. Main's whole contribution is the desktop source
 * id, which is transferable; the stream, the encoder and the bytes never leave
 * this file.
 *
 * The transport is a separate always-on-top window rather than something drawn
 * in here, and that is the one thing the desktop app can do that the extension
 * could not: `setContentProtection` tells the compositor to leave that window
 * out of any capture, so the stop button is on screen for the user and absent
 * from the file. In the extension the bar was DOM inside the recorded tab and
 * necessarily ended up in the video.
 */

import { el, icon, toast, mmss, humanBytes, drawCaps } from './ui.js'
import { state, storeRecording, setPhase, elapsed, go, refreshView } from './app.js'

/** Best first; the first the engine admits to supporting wins. */
const CONTAINERS = [
  { mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
  { mimeType: 'video/mp4', ext: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mimeType: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { mimeType: 'video/webm', ext: 'webm' }
]

function pickContainer() {
  for (const candidate of CONTAINERS) {
    if (MediaRecorder.isTypeSupported?.(candidate.mimeType)) return candidate
  }
  return { mimeType: '', ext: 'webm' }
}

export function mountRecord({ root, api }) {
  const sources = el('div.sources')
  const recBtn = el('button.cta.rec', { type: 'button' }, [icon('record'), el('span'), el('span.kbd')])
  const pauseBtn = el('button.pausebtn', { type: 'button', title: 'Pause', hidden: true }, [icon('pause')])
  const note = el('div.note.ok', {}, [icon('bolt'), el('span')])
  const meter = el('span.hint')

  const fpsOut = el('output', { text: '30 fps' })
  const fps = el('input', { type: 'range', min: '10', max: '60', step: '5', value: '30', 'aria-label': 'Frame rate' })
  const rateOut = el('output', { text: '8 Mbps' })
  const rate = el('input', { type: 'range', min: '1', max: '40', step: '1', value: '8', 'aria-label': 'Bitrate' })

  const modes = el('div.seg', { role: 'group', 'aria-label': 'Recording source' }, [
    el('button', { type: 'button', dataset: { source: 'screen' }, 'aria-pressed': 'true', onClick: () => set({ recordSource: 'screen' }) }, [icon('monitor'), 'Display']),
    el('button', { type: 'button', dataset: { source: 'window' }, 'aria-pressed': 'false', onClick: () => set({ recordSource: 'window' }) }, [icon('window'), 'Window'])
  ])

  const audioCard = el('div.card', {}, [
    el('h2', { text: 'Audio' }),
    el('p.sub', { text: 'Both are optional and both are mixed into the same file.' }),
    el('div.rows', {}, [
      toggleRow('recordAudio', 'speaker', 'System audio', 'What the machine is playing.'),
      toggleRow('recordMic', 'mic', 'Microphone', 'Narration, with echo cancellation on.')
    ])
  ])

  const qualityCard = el('div.card', {}, [
    el('h2', { text: 'Quality' }),
    el('p.sub', { text: 'Higher costs disk. 30 fps at 8 Mbps is about 60 MB a minute at 1080p.' }),
    el('label.field', {}, [el('span.lab', { text: 'Frame rate' }), el('div.slider', {}, [fps, fpsOut])]),
    el('label.field', {}, [el('span.lab', { text: 'Bitrate' }), el('div.slider', {}, [rate, rateOut])])
  ])

  const barCard = el('div.card', {}, [
    el('h2', { text: 'While recording' }),
    el('p.sub', { text: 'The transport floats above everything, so stopping never means finding this window again.' }),
    el('div.rows', {}, [
      toggleRow('recorderBar', 'bolt', 'Floating transport', 'Pause, stop and the elapsed time, on top of every app.'),
      toggleRow('protectBar', 'shield', 'Keep it out of the recording',
        'The compositor is told to exclude the transport from any capture.')
    ])
  ])

  root.classList.add('split')
  root.append(
    el('div.scroller', {}, [
      el('div.view-head', {}, [
        el('div.body', {}, [
          el('h1', { text: 'Record' }),
          el('p', { text: 'Record a display or a single window, with system audio and narration. Recordings are written to the session as they go, so a crash costs seconds rather than the take.' })
        ])
      ]),
      el('div.grid-2', {}, [
        el('div', {}, [
          modes,
          el('div', { style: { height: '14px' } }),
          el('div.card', {}, [
            el('h2', { text: 'What to record' }),
            el('p.sub', { text: 'Previews refresh when you open this view.' }),
            sources
          ]),
          el('div', { style: { height: '14px' } }),
          note
        ]),
        el('div', {}, [audioCard, el('div', { style: { height: '14px' } }), qualityCard,
          el('div', { style: { height: '14px' } }), barCard])
      ])
    ]),
    el('div.dock', {}, [
      el('div.dock-inner', {}, [
        el('div.dock-context', {}, [meter]),
        el('div.dock-action', {}, [pauseBtn, recBtn])
      ])
    ])
  )

  function toggleRow(key, glyph, label, sub) {
    const sw = el('button.switch', {
      type: 'button', role: 'switch', 'aria-checked': 'false',
      'aria-label': label, dataset: { setting: key },
      onClick: () => set({ [key]: sw.getAttribute('aria-checked') !== 'true' })
    })
    return el('div.row', {}, [
      icon(glyph),
      el('span.body', {}, [el('span.label', { text: label }), sub ? el('span.sub', { text: sub }) : null]),
      sw
    ])
  }

  const set = async (patch) => {
    state.settings = await api.settings.write(patch)
    paint()
    if (patch.recordSource) loadSources()
  }

  fps.addEventListener('input', () => { fpsOut.textContent = `${fps.value} fps` })
  fps.addEventListener('change', () => set({ fps: Number(fps.value) }))
  rate.addEventListener('input', () => { rateOut.textContent = `${rate.value} Mbps` })
  rate.addEventListener('change', () => set({ bitrate: Number(rate.value) }))

  /* ──────────────────────────────────────────────────────────── sources */

  let chosen = null
  async function loadSources() {
    const kinds = state.settings.recordSource === 'window' ? ['window'] : ['screen']
    sources.replaceChildren(el('p.sub', { text: 'Looking…', style: { gridColumn: '1 / -1' } }))
    const found = await api.shot.sources(kinds)
    if (!found.length) {
      sources.replaceChildren(el('div.empty', { style: { gridColumn: '1 / -1' } }, [
        el('span.glyph', {}, [icon('window')]), el('b', { text: 'Nothing to record' })
      ]))
      return
    }
    if (!chosen || !found.some((s) => s.id === chosen)) chosen = found[0].id
    sources.replaceChildren(...found.map((source) => {
      const tile = el('button.source', {
        type: 'button', 'aria-pressed': String(source.id === chosen), title: source.name,
        onClick: () => {
          chosen = source.id
          for (const node of sources.children) node.setAttribute('aria-pressed', String(node.dataset.id === source.id))
          paint()
        }
      }, [
        el('span.frame', {}, [
          source.thumbnail ? el('img', { src: source.thumbnail, alt: '' }) : el('span.none', { text: 'No preview' })
        ]),
        el('span.meta', {}, [
          source.icon ? el('img', { src: source.icon, alt: '' }) : icon(source.kind === 'screen' ? 'monitor' : 'window'),
          el('span', { text: source.name })
        ]),
        el('span.tick', {}, [icon('check')])
      ])
      tile.dataset.id = source.id
      // Which display this source is, so the transport and the count-in can be
      // put on the screen actually being recorded.
      if (source.displayId) tile.dataset.displayId = String(source.displayId)
      return tile
    }))
    paint()
  }

  /* ──────────────────────────────────────────────────────── the recorder */

  let recorder = null
  let stream = null
  let extra = []
  let chunks = []
  let container = null
  let dims = { width: 0, height: 0 }
  let sizeTicker = 0
  let barTicker = 0
  /** Stops the compositor's animation frame, when there is one. */
  let cleanupComposite = null

  /**
   * Open the stream.
   *
   * The `chromeMediaSource: 'desktop'` constraint is not standard and has never
   * had a promise-shaped equivalent — it only works through the legacy
   * mandatory-constraints object, which is why this looks like 2014.
   */
  async function openStream(sourceId) {
    const settings = state.settings
    const video = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: settings.fps
      }
    }
    const constraints = { video }
    if (settings.recordAudio) {
      // On Windows the loopback only attaches to a whole display; asking for it
      // alongside a window source fails the entire getUserMedia call, which
      // would look like "recording is broken" rather than "no system audio".
      constraints.audio = { mandatory: { chromeMediaSource: 'desktop' } }
    }

    let base
    try {
      base = await navigator.mediaDevices.getUserMedia(constraints)
    } catch (err) {
      if (!constraints.audio) throw err
      toast('System audio is not available for this source — recording without it', { tone: 'warn' })
      base = await navigator.mediaDevices.getUserMedia({ video })
    }

    if (settings.recordMic) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true }
        })
        for (const track of mic.getAudioTracks()) {
          base.addTrack(track)
          extra.push(track)
        }
      } catch {
        // A missing microphone must not lose the take that was about to happen.
        toast('No microphone was available — recording without narration', { tone: 'warn' })
      }
    }

    // Everything above produced the source stream. What actually gets recorded
    // may be a composited copy of it — see `composite`.
    return settings.keypress ? composite(base, settings.fps) : base
  }

  /**
   * Draw the keys into the video, rather than hoping the overlay is in shot.
   *
   * The overlay is a real window, so a *display* recording of the display it
   * happens to be on does contain it — which is why this looked like it worked.
   * It does not work anywhere else. A **window** recording captures that
   * window's own content and never anything floating above it, and a display
   * recording of the other monitor has no overlay on it at all. Both are
   * ordinary things to do, and in both the keys were simply missing.
   *
   * So the frames go through a canvas: the source video underneath, the same
   * strip the screenshots burn in painted on top, and the canvas is what gets
   * recorded. Only when the feature is on — otherwise the source stream is
   * handed back untouched and this costs nothing.
   *
   * The audio tracks move across as they are. Only the video is replaced.
   */
  function composite(base, fps) {
    const [source] = base.getVideoTracks()
    const settings = source.getSettings()
    const width = settings.width || 1920
    const height = settings.height || 1080

    const video = document.createElement('video')
    video.srcObject = new MediaStream([source])
    video.muted = true
    video.playsInline = true

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { alpha: false })

    /**
     * A timer, not `requestAnimationFrame`.
     *
     * This is the bug that made a composited recording come out empty. The app
     * minimises itself when a take starts, and Chromium stops serving animation
     * frames to a minimised window — so the draw loop stopped on the first
     * frame, the canvas was never painted again, and `captureStream` produced
     * nothing. The recording ran, saved, and was zero seconds long.
     *
     * A timer keeps running, and with `backgroundThrottling: false` on the
     * window it keeps running at the rate asked for rather than being clamped
     * to once a second. The desktop stream feeding the `<video>` is unaffected
     * by any of this — it comes from the compositor, not from our window.
     */
    let timer = 0
    const draw = () => {
      // `readyState` guards the first frames, before the element has any
      // picture — drawing then throws and would kill the loop for the take.
      if (video.readyState < 2) return
      ctx.drawImage(video, 0, 0, width, height)
      drawCaps(ctx, state.keys, state.settings, canvas)
    }
    const begin = () => { timer = setInterval(draw, Math.max(16, Math.round(1000 / fps))) }
    video.play().then(begin).catch(begin)

    const out = canvas.captureStream(fps)
    for (const track of base.getAudioTracks()) out.addTrack(track)

    // The source video track is not in the recorded stream, so `cleanup` would
    // not reach it — it is registered here instead.
    extra.push(source)
    cleanupComposite = () => {
      clearInterval(timer)
      video.srcObject = null
    }
    return out
  }

  async function start() {
    if (recorder) return
    if (!chosen) { toast('Pick something to record first', { tone: 'warn' }); return }

    setPhase('busy')
    try {
      stream = await openStream(chosen)
      const track = stream.getVideoTracks()[0]
      const trackSettings = track.getSettings()
      dims = { width: trackSettings.width || 0, height: trackSettings.height || 0 }
      container = pickContainer()

      chunks = []
      recorder = new MediaRecorder(stream, {
        mimeType: container.mimeType || undefined,
        videoBitsPerSecond: state.settings.bitrate * 1_000_000
      })

      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data) }
      recorder.onerror = (event) => {
        toast(`Recording failed: ${event.error?.message || 'unknown'}`, { tone: 'bad' })
        stop(true)
      }
      recorder.onstop = finish

      // The user can also end it from the OS "you are sharing your screen" bar,
      // and that arrives as the track simply ending.
      track.addEventListener('ended', () => stop())

      /**
       * Get out of the way, then count.
       *
       * In this order for a reason. Minimising first means the count is over
       * whatever is about to be recorded rather than over this window, and the
       * seconds are seconds the user actually has to get to the thing they
       * want — which is the whole point of a count-in. Counting first and then
       * minimising would spend the count on the app disappearing.
       *
       * Both come after the stream is open, so any permission prompt has been
       * and gone before the clock starts.
       */
      await api.app.standAside()

      const countIn = Number(state.settings.countIn) || 0
      for (let n = countIn; n > 0; n--) {
        recBtn.children[1].textContent = `Starting in ${n}…`
        // A full-screen overlay, not the app window — which is minimised by
        // now, so a number drawn in it would be counting down behind the
        // taskbar.
        await api.count.show({ n, displayId: chosenDisplay() })
        await new Promise((resolve) => setTimeout(resolve, 1000))
        // Stopped during the count: the take never started, so nothing to save.
        if (!recorder) { await api.count.hide(); return }
      }
      await api.count.hide()

      // A one-second timeslice rather than one blob at the end: the encoder
      // hands over what it has as it goes, so a crash costs the last second.
      recorder.start(1000)
      state.recording = { startedAt: Date.now(), pausedMs: 0, pausedAt: 0 }
      setPhase('recording')
      showBar()
      startMeter()
    } catch (err) {
      cleanup()
      await api.count.hide()
      await api.app.comeBack()
      setPhase('ready')
      toast(explain(err), { tone: 'bad' })
    }
    paint()
  }

  function pause() {
    if (recorder?.state !== 'recording') return
    recorder.pause()
    state.recording.pausedAt = Date.now()
    setPhase('paused')
    pushBar()
    paint()
  }

  function resume() {
    if (recorder?.state !== 'paused') return
    recorder.resume()
    state.recording.pausedMs += state.recording.pausedAt ? Date.now() - state.recording.pausedAt : 0
    state.recording.pausedAt = 0
    setPhase('recording')
    pushBar()
    paint()
  }

  function stop() {
    if (!recorder) return
    setPhase('saving')
    // `stop()` from `paused` is legal and flushes what it has, so there is no
    // resume-then-stop dance.
    if (recorder.state !== 'inactive') recorder.stop()
    else finish()
  }

  async function finish() {
    const durationMs = elapsed()
    const blob = new Blob(chunks, { type: container?.mimeType || 'video/webm' })
    chunks = []
    cleanup()

    try {
      if (!blob.size) throw new Error('Nothing was recorded.')
      const entry = await storeRecording({
        blob,
        container: container?.ext || 'webm',
        mimeType: container?.mimeType || 'video/webm',
        width: dims.width,
        height: dims.height,
        durationMs,
        source: { id: chosen, kind: state.settings.recordSource },
        audio: { system: state.settings.recordAudio, mic: state.settings.recordMic }
      })
      toast(`Recording saved · ${mmss(durationMs)} · ${humanBytes(entry.bytes)}`, {
        action: 'Library', onAction: () => go('library')
      })
      refreshView('library')
    } catch (err) {
      toast(String(err?.message || err), { tone: 'bad' })
    } finally {
      state.recording = { startedAt: 0, pausedMs: 0, pausedAt: 0 }
      setPhase('ready')
      hideBar()
      // Back on screen, so the toast about the saved recording lands somewhere
      // the user can see it. Only if this put it away in the first place.
      await api.app.comeBack()
      paint()
    }
  }

  function cleanup() {
    clearInterval(sizeTicker)
    clearInterval(barTicker)
    cleanupComposite?.()
    cleanupComposite = null
    for (const track of [...(stream?.getTracks() || []), ...extra]) {
      try { track.stop() } catch { /* already gone */ }
    }
    extra = []
    stream = null
    recorder = null
  }

  /** Bytes so far, so a long take does not quietly fill the disk. */
  function startMeter() {
    clearInterval(sizeTicker)
    const paintMeter = () => {
      const bytes = chunks.reduce((n, c) => n + c.size, 0)
      meter.textContent = `${mmss(elapsed())} recorded · ${humanBytes(bytes)} on disk · ${container?.ext.toUpperCase()}`
    }
    paintMeter()
    sizeTicker = setInterval(paintMeter, 1000)
  }

  /* ─────────────────────────────────────────────────────── the transport */

  function showBar() {
    if (!state.settings.recorderBar) return
    api.bar.show(barState())
    clearInterval(barTicker)
    barTicker = setInterval(pushBar, 500)
  }

  const barProtected = () => Boolean(state.settings.protectBar && state.info?.canProtect)

  /**
   * The display behind the chosen source.
   *
   * `undefined` for a window recording, which has no display of its own — main
   * then falls back to wherever the pointer is, which is the best guess at
   * where the user is looking.
   */
  const chosenDisplay = () => {
    const tile = [...sources.children].find((n) => n.dataset.id === chosen)
    const id = Number(tile?.dataset.displayId)
    return Number.isFinite(id) && id !== 0 ? id : undefined
  }

  const barState = () => ({
    phase: state.phase,
    elapsedMs: elapsed(),
    protect: barProtected(),
    displayId: chosenDisplay()
  })

  const pushBar = () => { if (state.settings.recorderBar) api.bar.update(barState()) }
  const hideBar = () => { clearInterval(barTicker); api.bar.hide() }

  /* ───────────────────────────────────────────────────────────── wiring */

  recBtn.addEventListener('click', () => {
    if (state.phase === 'recording' || state.phase === 'paused') stop()
    else start()
  })
  pauseBtn.addEventListener('click', () => (state.phase === 'paused' ? resume() : pause()))

  api.bar.onAction((action) => {
    if (action === 'stop') stop()
    else if (action === 'pause') pause()
    else if (action === 'resume') resume()
  })

  api.hotkeys.onPressed(({ action }) => {
    if (action === 'toggleRecording') recBtn.click()
    else if (action === 'pauseRecording' && (state.phase === 'recording' || state.phase === 'paused')) pauseBtn.click()
  })

  /* ─────────────────────────────────────────────────────────── painting */

  function paint() {
    const settings = state.settings
    const rolling = state.phase === 'recording' || state.phase === 'paused'
    const live = rolling || state.phase === 'saving'

    for (const node of modes.children) {
      node.setAttribute('aria-pressed', String(node.dataset.source === settings.recordSource))
      node.disabled = live
    }
    for (const node of root.querySelectorAll('[data-setting]')) {
      node.setAttribute('aria-checked', String(Boolean(settings[node.dataset.setting])))
      // Changing the source or the audio mid-take cannot apply to a stream that
      // is already open, so the controls say so by not being available.
      node.disabled = live && node.dataset.setting !== 'recorderBar'
    }
    fps.value = String(settings.fps)
    fpsOut.textContent = `${settings.fps} fps`
    rate.value = String(settings.bitrate)
    rateOut.textContent = `${settings.bitrate} Mbps`
    fps.disabled = rate.disabled = live

    recBtn.classList.toggle('live', live)
    recBtn.firstElementChild.replaceWith(icon(live ? 'stop' : 'record'))
    recBtn.children[1].textContent = live
      ? `Stop · ${mmss(elapsed())}`
      : 'Start recording'
    recBtn.lastElementChild.textContent = pretty(settings.hotkeys.toggleRecording)
    recBtn.disabled = state.phase === 'busy' || state.phase === 'saving'

    pauseBtn.hidden = !rolling
    pauseBtn.firstElementChild.replaceWith(icon(state.phase === 'paused' ? 'play' : 'pause'))
    pauseBtn.title = state.phase === 'paused' ? 'Resume' : 'Pause'

    // The one claim that depends on the platform, so it is made conditionally.
    const protect = settings.protectBar && state.info?.canProtect
    note.hidden = !settings.recorderBar
    note.className = protect ? 'note ok' : 'note'
    note.lastElementChild.textContent = protect
      ? 'The floating transport is excluded from the recording, so the controls are on screen but not in the file.'
      : state.info?.canProtect === false
        ? 'This platform cannot exclude a window from a capture, so the transport will appear in a full-display recording. Record a single window to keep it out.'
        : 'The transport will appear in the recording — turn on “Keep it out of the recording” to exclude it.'

    // Idle, the dock's left region says what pressing the button will do —
    // source, size, audio — rather than sitting empty until it has a number to
    // show. It is the last thing read before committing to a take.
    if (!live) {
      const picked = [...sources.children].find((n) => n.dataset.id === chosen)
      const name = picked?.querySelector('.meta span')?.textContent
      meter.textContent = [
        name ? `Ready to record ${name}` : 'Pick something to record',
        `${settings.fps} fps · ${settings.bitrate} Mbps`,
        [settings.recordAudio && 'system audio', settings.recordMic && 'mic']
          .filter(Boolean).join(' + ') || 'no audio'
      ].join('  ·  ')
    }
  }

  let paintTicker = 0
  return {
    async enter() {
      paint()
      await loadSources()
      // The button carries a live clock while recording, and the view can be
      // opened mid-take.
      clearInterval(paintTicker)
      paintTicker = setInterval(() => {
        if (state.phase === 'recording') paint()
      }, 500)
    }
  }
}

function explain(err) {
  const text = String(err?.message || err)
  if (/NotAllowedError|Permission denied/i.test(text)) {
    return 'Screen recording was not permitted. On macOS, allow Rebind Capture under Privacy & Security → Screen Recording.'
  }
  if (/NotFoundError|no.*device/i.test(text)) return 'That source is no longer available.'
  if (/NotReadableError/i.test(text)) return 'Something else is already using that source.'
  return `Recording could not start: ${text.slice(0, 140)}`
}

function pretty(combo) {
  if (!combo) return ''
  const mac = navigator.platform.toLowerCase().includes('mac')
  return combo
    .replace(/CommandOrControl|CmdOrCtrl/g, mac ? '⌘' : 'Ctrl')
    .replace(/Alt/g, mac ? '⌥' : 'Alt')
    .replace(/Shift/g, mac ? '⇧' : 'Shift')
    .split('+')
    .join(mac ? '' : '+')
}
