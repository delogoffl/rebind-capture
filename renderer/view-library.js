/**
 * The Library view: everything captured, and getting it back out.
 *
 * Two selections, kept apart. Steps are picked in the grid and recordings are
 * picked in their own rows, because a session is often a dozen screenshots and
 * three takes of a video, and "export" means a different subset of each. The
 * browser extension this grew out of got that wrong — the video format silently
 * exported the most recent recording whatever was selected, so five of six
 * takes were unreachable. Every recording here is its own row, ticked or not,
 * with its own one-click download.
 */

import { el, icon, toast, confirm, promptFor, mmss, humanBytes, when, bytesToUrl, toJpeg, thumbnail } from './ui.js'
import { state, refreshSessions, forgetSession, go } from './app.js'
import { buildExport, estimate, outputName } from '../lib/export.js'
// Never from `lib/store.js`: it imports `node:fs` at the top level, which a
// sandboxed renderer cannot resolve, and the failure takes the whole view down
// rather than just the one helper.
import { renumber, summarise, addStep, originalName } from '../lib/session.js'
import { openEditor, burnAnnotations } from './editor.js'
import { hasRedaction, describe as describeMarks } from '../lib/annotate.js'
import { digest, describeVerification } from '../lib/manifest.js'
import { diffRegions, scaleRegions } from '../lib/diff.js'
import { planSteps, describePlan } from '../lib/marks.js'

export function mountLibrary({ root, api }) {
  const sessionList = el('div.sessions')
  const shots = el('div.shots')
  const tapes = el('div.tapes')
  /**
   * Two empty states, because they are two different situations.
   *
   * Nothing in the library at all: there is no session list to show either, so
   * the two-column grid goes away and the message has the whole view to centre
   * in. It used to live inside the right-hand column, which centres it beside a
   * 272px sidebar — and next to a sidebar, centred-in-the-remainder reads as
   * shoved to the right.
   *
   * A session that is open but empty: the sidebar is still useful, so the grid
   * stays and the message centres in the content column, which is exactly where
   * its content would have been.
   */
  const emptyAll = el('div.empty.full', { hidden: true }, [
    el('span.glyph', {}, [icon('layers')]),
    el('b', { text: 'Nothing captured yet' }),
    el('div', { text: 'Take a shot or record something and it appears here.' }),
    el('div', { style: { marginTop: '20px' } }, [
      el('button.btn', { type: 'button', onClick: () => go('capture') }, [icon('camera'), 'Take a capture'])
    ])
  ])

  const emptySession = el('div.empty', { hidden: true }, [
    el('span.glyph', {}, [icon('camera')]),
    el('b', { text: 'This session is empty' }),
    el('div', { text: 'Nothing has been captured into it yet.' })
  ])

  const stepsRule = el('div.rule', {}, [
    el('p.eyebrow', { text: 'Steps' }), el('span.line'),
    el('button.btn.quiet', { type: 'button', onClick: toggleAll }, ['Select all'])
  ])
  const tapesRule = el('div.rule', {}, [el('p.eyebrow', { text: 'Recordings' }), el('span.line')])

  const formats = el('div.seg', { role: 'group', 'aria-label': 'Export format' }, [
    fmtButton('pdf', 'PDF'), fmtButton('png', 'PNG'), fmtButton('md', 'Markdown'), fmtButton('video', 'Video')
  ])
  const exportBtn = el('button.cta', { type: 'button' }, [icon('download'), el('span')])
  const dockHint = el('span.hint')
  const dock = el('div.dock', { hidden: true }, [
    el('div.dock-inner', {}, [
      el('div.dock-context', {}, [formats, dockHint]),
      el('div.dock-action', {}, [exportBtn])
    ])
  ])

  const title = el('h1', { text: 'Library' })
  const subtitle = el('p')
  const headActions = el('div.actions')

  // The dock lives outside the scroll area and outside the two-column grid, so
  // it is always visible and always the full width of the view.
  root.classList.add('split')
  root.append(
    el('div.scroller', {}, [
      el('div.view-head', {}, [el('div.body', {}, [title, subtitle]), headActions]),
      // `empty` is deliberately outside the two-column grid. Inside it, it
      // centred itself within the right-hand column — which, next to a 272px
      // sidebar, reads as shoved to the right rather than as centred. An empty
      // state has no columns to belong to.
      emptyAll,
      el('div.library', { id: 'libraryGrid' }, [
        el('div', {}, [
          el('p.eyebrow', { text: 'Sessions', style: { marginBottom: '8px' } }),
          sessionList
        ]),
        el('div', {}, [emptySession, tapesRule, tapes, stepsRule, shots])
      ])
    ]),
    dock
  )

  /* ─────────────────────────────────────────────────────────────── state */

  let openId = null
  let session = null
  let pickedSteps = new Set()
  let pickedTapes = new Set()
  // The stored default, not a hard-coded one. This was `'pdf'` regardless of
  // what the user had chosen, which made the Export section of Settings a
  // control that changed nothing.
  let format = state.settings?.exportFormat || 'pdf'
  const urls = new Set()

  const url = (bytes, type) => {
    const made = bytesToUrl(bytes, type)
    urls.add(made)
    return made
  }
  const revokeAll = () => { for (const u of urls) URL.revokeObjectURL(u); urls.clear() }
  addEventListener('pagehide', revokeAll)

  function fmtButton(name, label) {
    return el('button', {
      type: 'button', dataset: { fmt: name }, 'aria-pressed': 'false',
      onClick: () => {
        format = name
        paintDock()
        // Remembered, so the next session opens on the format this one used.
        api.settings.write({ exportFormat: name }).then((next) => { state.settings = next })
      }
    }, [label])
  }

  /* ────────────────────────────────────────────────────────────── loading */

  async function loadSessions() {
    const list = await refreshSessions()

    if (!list.length) {
      sessionList.replaceChildren(el('p.sub', { text: 'No sessions yet.', style: { color: 'var(--faint)' } }))
      openId = null
      await openSession(null)
      return
    }

    if (!openId || !list.some((s) => s.id === openId)) openId = state.session?.id || list[0].id

    sessionList.replaceChildren(...list.map((item) => el('button.session-row', {
      type: 'button',
      'aria-current': String(item.id === openId),
      onClick: () => openSession(item.id)
    }, [
      icon(item.media && !item.steps ? 'record' : 'layers'),
      el('span.body', {}, [
        el('b', { text: item.label || item.name }),
        el('span', {
          text: `${item.steps} step${item.steps === 1 ? '' : 's'}${item.media ? ` · ${item.media} rec` : ''} · ${when(item.updatedAt)}`
        })
      ])
    ])))

    await openSession(openId)
  }

  async function openSession(id) {
    revokeAll()
    openId = id
    session = id ? await api.library.read(id) : null

    for (const node of sessionList.children) {
      if (node.setAttribute) node.setAttribute('aria-current', String(false))
    }
    const index = state.sessions.findIndex((s) => s.id === id)
    sessionList.children[index]?.setAttribute?.('aria-current', 'true')

    if (!session) {
      title.textContent = 'Library'
      subtitle.textContent = 'Captures and recordings, grouped by session.'
      headActions.replaceChildren()
      emptyAll.hidden = false
      emptySession.hidden = true
      root.querySelector('#libraryGrid').hidden = true
      stepsRule.hidden = tapesRule.hidden = true
      shots.replaceChildren()
      tapes.replaceChildren()
      dock.hidden = true
      return
    }
    root.querySelector('#libraryGrid').hidden = false
    emptyAll.hidden = true

    // Everything starts selected: the common case is exporting the whole
    // session, and deselecting three is less work than selecting twelve.
    pickedSteps = new Set(session.steps.map((s) => s.id))
    pickedTapes = new Set(session.media.map((m) => m.id))

    const sum = summarise(session)
    title.textContent = session.label || session.name
    subtitle.textContent =
      `${sum.steps} step${sum.steps === 1 ? '' : 's'} · ${sum.media} recording${sum.media === 1 ? '' : 's'} · ` +
      `${humanBytes(sum.bytes)} · started ${new Date(session.startedAt).toLocaleString()}`

    headActions.replaceChildren(
      el('button.btn', { type: 'button', onClick: renameSession, title: 'Rename this session' }, [icon('pen'), 'Rename']),
      el('button.btn', { type: 'button', onClick: editNotes, title: 'Notes, printed at the top of the export' }, [icon('file'), 'Notes']),
      el('button.btn', {
        type: 'button', dataset: { act: 'verify' }, onClick: verify,
        title: 'Re-hash every file and compare against what was recorded at capture'
      }, [icon('shield'), 'Verify']),
      el('button.btn', { type: 'button', onClick: () => api.library.reveal(session.id) }, [icon('folder'), 'Show files']),
      el('button.btn', { type: 'button', onClick: doRenumber, title: 'Close gaps left by deleted steps' }, [icon('refresh'), 'Renumber']),
      el('button.btn.danger', { type: 'button', onClick: doDeleteSession }, [icon('trash'), 'Delete session'])
    )

    emptySession.hidden = sum.steps > 0 || sum.media > 0
    await paintTapes()
    await paintShots()
    paintDock()
  }

  /* ────────────────────────────────────────────────────────────── steps */

  async function paintShots() {
    stepsRule.hidden = !session.steps.length
    if (!session.steps.length) { shots.replaceChildren(); return }

    const tiles = await Promise.all(session.steps.map(async (step) => {
      let src = null
      try {
        // The thumbnail, never the original: thirty 4K PNGs decoded into a grid
        // is several gigabytes of bitmap.
        src = url(await api.library.readAsset({ sessionId: session.id, name: step.thumb }))
      } catch {
        src = null
      }

      const toggle = () => {
        if (pickedSteps.has(step.id)) pickedSteps.delete(step.id)
        else pickedSteps.add(step.id)
        tile.setAttribute('aria-pressed', String(pickedSteps.has(step.id)))
        paintDock()
      }

      /**
       * A real delete, on the tile.
       *
       * Deleting a step used to be alt-click on the tile — a gesture with
       * nothing on screen to suggest it exists, so in practice there was no way
       * to delete a capture at all. It appears on hover and on keyboard focus,
       * so it is discoverable without being permanent clutter over the picture.
       */
      const rename = el('button.shot-edit', {
        type: 'button',
        title: `Rename step ${step.index}`,
        'aria-label': `Rename step ${step.index}`,
        onClick: (event) => { event.stopPropagation(); renameStep(step) }
      }, [icon('pen')])

      const mark = el('button.shot-mark', {
        type: 'button',
        title: `Mark up step ${step.index}`,
        'aria-label': `Mark up step ${step.index}`,
        onClick: (event) => { event.stopPropagation(); annotateStep(step) }
      }, [icon('crop')])

      const drop = el('button.shot-del', {
        type: 'button',
        title: `Delete step ${step.index}`,
        'aria-label': `Delete step ${step.index}`,
        onClick: (event) => {
          // Without this the click also lands on the tile behind it and toggles
          // the selection on the way to opening the dialog.
          event.stopPropagation()
          removeStep(step)
        }
      }, [icon('trash')])

      /**
       * A div, not a button.
       *
       * The delete control has to live inside the tile, and a button nested in
       * a button is invalid HTML — browsers drop it out of the parent, and the
       * click stops being reliable.
       */
      const tile = el('div.shot', {
        role: 'button',
        tabindex: '0',
        dataset: { id: step.id },
        'aria-pressed': String(pickedSteps.has(step.id)),
        title: step.title,
        onClick: toggle,
        onKeydown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        }
      }, [
        src ? el('img', { src, alt: step.title, loading: 'lazy' }) : el('div', { style: { aspectRatio: '16/10' } }),
        el('span.n', { text: String(step.index) }),
        el('span.tick', {}, [icon('check')]),
        // A capture that has been drawn on says so on the tile. An annotated
        // image and an untouched one look alike at thumbnail size, and which
        // one you are about to attach to a ticket matters.
        step.annotations?.length
          ? el('span.marked', {
              title: describeMarks(step.annotations),
              dataset: { redacted: String(hasRedaction(step.annotations)) }
            }, [icon(hasRedaction(step.annotations) ? 'eye' : 'crop')])
          : null,
        mark,
        rename,
        drop,
        el('span.cap', { text: step.title })
      ])
      return tile
    }))
    shots.replaceChildren(...tiles)
  }

  function toggleAll() {
    if (!session) return
    if (pickedSteps.size === session.steps.length) pickedSteps.clear()
    else pickedSteps = new Set(session.steps.map((s) => s.id))
    for (const [i, node] of [...shots.children].entries()) {
      node.setAttribute('aria-pressed', String(pickedSteps.has(session.steps[i].id)))
    }
    stepsRule.lastElementChild.textContent =
      pickedSteps.size === session.steps.length ? 'Clear' : 'Select all'
    paintDock()
  }

  /* ────────────────────────────────────────────────────────── recordings */

  async function paintTapes() {
    tapesRule.hidden = !session.media.length
    if (!session.media.length) { tapes.replaceChildren(); return }

    tapes.replaceChildren(...session.media.map((item, i) => {
      // The id is on the row so `reveal` can find the recording that was just
      // saved, rather than the view having to guess from position.
      const row = el('div.tape', { dataset: { on: String(pickedTapes.has(item.id)), id: item.id } })

      const pick = el('button.pick', {
        type: 'button',
        'aria-pressed': String(pickedTapes.has(item.id)),
        'aria-label': `Include recording ${i + 1} in the export`,
        onClick: () => {
          if (pickedTapes.has(item.id)) pickedTapes.delete(item.id)
          else pickedTapes.add(item.id)
          row.dataset.on = String(pickedTapes.has(item.id))
          pick.setAttribute('aria-pressed', row.dataset.on)
          paintDock()
        }
      }, [icon('check')])

      const play = el('button.play', {
        type: 'button', 'aria-label': 'Play recording', onClick: () => playTape(item)
      }, [icon('play')])

      const facts = [
        mmss(item.durationMs),
        (item.container || 'webm').toUpperCase(),
        item.width ? `${item.width}×${item.height}` : null,
        humanBytes(item.bytes)
      ].filter(Boolean).join(' · ')

      /**
       * Only offered when there is something to make steps from.
       *
       * A recording taken before this existed, or with the setting off, has no
       * marks — and a button that always fails to find anything teaches people
       * to stop pressing it.
       */
      const cut = item.marks?.length
        ? el('button.btn.quiet', {
            type: 'button',
            title: 'Make numbered steps from the actions in this recording',
            'aria-label': 'Make steps from this recording',
            onClick: () => extractSteps(item)
          }, [icon('layers')])
        : null

      const grab = el('button.btn.quiet', {
        type: 'button', title: 'Save this recording', onClick: () => exportOne(item)
      }, [icon('download')])

      const remove = el('button.btn.quiet.danger', {
        type: 'button', title: 'Delete this recording', onClick: () => removeTape(item)
      }, [icon('trash')])

      row.append(pick, play, el('div.body', {}, [
        // Numbered and time-stamped, because "Screen recording" six times over
        // is not a list anyone can choose from.
        el('b', {}, [
          session.media.length > 1 ? `Recording ${i + 1}` : 'Screen recording',
          el('span.when', { text: when(item.startedAt) })
        ]),
        el('span.facts', { text: facts })
      ]), ...(cut ? [cut] : []), grab, remove)
      return row
    }))
  }

  /**
   * The player.
   *
   * This used to be a bare `<video controls>` on a dimmed backdrop, which is
   * the browser's player and not this app's — different on every platform,
   * styled like nothing else here, and unable to say anything about the thing
   * it is playing.
   *
   * The chrome is therefore ours, and the reason it is worth owning is on the
   * timeline: a recording carries the clicks and keystrokes that happened
   * during it (`item.marks`), so they can be drawn as ticks along the scrubber.
   * That turns a featureless bar into a map of the take — the dense stretch is
   * where the work happened, the gap is where you were reading — and clicking
   * a tick jumps to that action. No third-party player could show that,
   * because no third-party player knows what a mark is.
   */
  async function playTape(item) {
    const bytes = await api.library.readAsset({ sessionId: session.id, name: item.file })
    const src = url(bytes, item.mimeType || 'video/webm')

    const video = el('video', { class: 'pv-video', src, autoplay: true, playsInline: true })

    /* ─────────────────────────────────────────────────────────── timeline */

    const played = el('span.pv-played')
    const buffered = el('span.pv-buffered')
    const knob = el('span.pv-knob')
    const ticks = el('span.pv-ticks')
    const ghost = el('span.pv-ghost', { hidden: true })
    const rail = el('div.pv-rail', {
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Seek',
      'aria-valuemin': '0'
    }, [buffered, played, ticks, knob, ghost])

    const elapsedOut = el('span.pv-time', { text: '0:00' })
    const totalOut = el('span.pv-time.dim', { text: mmss(item.durationMs) })

    /**
     * Where the actions were, in the video's own timeline.
     *
     * Computed with the same `planSteps` the extraction uses, so a tick sits
     * exactly where a step would be cut — including the pause arithmetic. A
     * second implementation here would drift, and the two would disagree about
     * a recording in front of the user.
     */
    const actions = item.marks?.length
      ? planSteps(item.marks, {
          startedAt: item.startedAt,
          durationMs: item.durationMs,
          pauses: item.pauses || []
        }, {
          max: state.settings.autoStepsMax,
          clicksOnly: state.settings.autoStepsOn === 'clicks'
        })
      : []

    const paintTicks = () => {
      const total = duration()
      if (!total || !actions.length) return
      ticks.replaceChildren(...actions.map((a) => el('i.pv-tick', {
        title: `${a.label} · ${mmss(a.offsetMs)}`,
        style: { left: `${Math.min(100, (a.offsetMs / total) * 100)}%` },
        onClick: (event) => { event.stopPropagation(); video.currentTime = a.offsetMs / 1000 }
      })))
    }

    /**
     * The duration, defended.
     *
     * A recording written by MediaRecorder can report `Infinity` until the
     * whole file has been walked, and a progress bar dividing by that draws
     * nothing while looking like it is working. The stored duration is the
     * measured wall clock of the take and is always a real number, so it is
     * the fallback.
     */
    const duration = () => {
      const known = video.duration
      return Number.isFinite(known) && known > 0 ? known * 1000 : item.durationMs || 0
    }

    const paintProgress = () => {
      const total = duration()
      const at = video.currentTime * 1000
      const pct = total ? Math.min(100, (at / total) * 100) : 0
      played.style.width = `${pct}%`
      knob.style.left = `${pct}%`
      elapsedOut.textContent = mmss(at)
      totalOut.textContent = mmss(total)
      rail.setAttribute('aria-valuemax', String(Math.round(total / 1000)))
      rail.setAttribute('aria-valuenow', String(Math.round(at / 1000)))
      rail.setAttribute('aria-valuetext', `${mmss(at)} of ${mmss(total)}`)
      if (video.buffered.length) {
        const end = video.buffered.end(video.buffered.length - 1) * 1000
        buffered.style.width = `${total ? Math.min(100, (end / total) * 100) : 0}%`
      }
    }

    const seekFromEvent = (event) => {
      const box = rail.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
      video.currentTime = (duration() * ratio) / 1000
    }

    let scrubbing = false
    rail.addEventListener('pointerdown', (event) => {
      scrubbing = true
      rail.setPointerCapture(event.pointerId)
      seekFromEvent(event)
    })
    rail.addEventListener('pointermove', (event) => {
      const box = rail.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
      ghost.hidden = false
      ghost.style.left = `${ratio * 100}%`
      ghost.textContent = mmss(duration() * ratio)
      if (scrubbing) seekFromEvent(event)
    })
    rail.addEventListener('pointerleave', () => { ghost.hidden = true })
    rail.addEventListener('pointerup', () => { scrubbing = false })

    /* ──────────────────────────────────────────────────────────── controls */

    const playBtn = el('button.pv-btn.pv-play', {
      type: 'button', 'aria-label': 'Play', onClick: () => toggle()
    }, [icon('play')])

    // One glyph, mirrored for the backwards one — the icon set has a circular
    // arrow and no pair of directional skips, and two identical buttons either
    // side of play would be worse than one flipped.
    const skip = (seconds, label, cls) => el(`button.pv-btn.${cls}`, {
      type: 'button', title: label, 'aria-label': label,
      onClick: () => { video.currentTime = Math.max(0, video.currentTime + seconds) }
    }, [icon('refresh'), el('span.pv-secs', { text: String(Math.abs(seconds)) })])

    const RATES = [0.5, 1, 1.5, 2]
    const rateBtn = el('button.pv-btn.pv-rate', {
      type: 'button', title: 'Playback speed', onClick: () => {
        const next = RATES[(RATES.indexOf(video.playbackRate) + 1) % RATES.length]
        video.playbackRate = next
        rateBtn.textContent = `${next}×`
      }
    }, [`${video.playbackRate || 1}×`])

    const muteBtn = el('button.pv-btn', {
      type: 'button', title: 'Mute', 'aria-label': 'Mute',
      onClick: () => {
        video.muted = !video.muted
        muteBtn.dataset.on = String(!video.muted)
        muteBtn.replaceChildren(icon(video.muted ? 'mic' : 'speaker'))
      }
    }, [icon('speaker')])

    const stepsBtn = actions.length
      ? el('button.pv-btn.pv-wide', {
          type: 'button',
          title: 'Make numbered steps from the actions in this recording',
          onClick: () => { close(); extractSteps(item) }
        }, [icon('layers'), `${actions.length} step${actions.length === 1 ? '' : 's'}`])
      : null

    const fullBtn = el('button.pv-btn', {
      type: 'button', title: 'Fullscreen', 'aria-label': 'Fullscreen',
      onClick: () => {
        if (document.fullscreenElement) document.exitFullscreen()
        else card.requestFullscreen?.()
      }
    }, [icon('monitor')])

    /* ───────────────────────────────────────────────────────────── chrome */

    const facts = [
      (item.container || 'webm').toUpperCase(),
      item.width ? `${item.width}×${item.height}` : null,
      humanBytes(item.bytes)
    ].filter(Boolean).join(' · ')

    const card = el('div.player', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Recording' }, [
      el('div.pv-head', {}, [
        el('div.pv-title', {}, [
          el('b', { text: session.media.length > 1 ? `Recording ${item.index}` : 'Screen recording' }),
          el('span', { text: facts })
        ]),
        // A plus turned 45 degrees is a cross; the icon set has no × of its own
        // and one glyph fewer is better than one glyph nearly duplicated.
        el('button.pv-btn.pv-close', {
          type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => close()
        }, [icon('plus')])
      ]),
      el('div.pv-stage', { onClick: () => toggle() }, [video, el('span.pv-flash', {}, [icon('play')])]),
      el('div.pv-foot', {}, [
        el('div.pv-scrub', {}, [elapsedOut, rail, totalOut]),
        el('div.pv-acts', {}, [
          playBtn,
          skip(-5, 'Back 5 seconds', 'pv-back'),
          skip(5, 'Forward 5 seconds', 'pv-fwd'),
          rateBtn,
          muteBtn,
          el('span.pv-gap'),
          stepsBtn,
          fullBtn
        ])
      ])
    ])

    const scrim = el('div.scrim.wide', {
      onMousedown: (event) => { if (event.target === scrim) close() }
    }, [card])

    /* ─────────────────────────────────────────────────────────── behaviour */

    const flash = card.querySelector('.pv-flash')
    const toggle = () => {
      if (video.paused) void video.play()
      else video.pause()
      // A one-shot pulse in the middle, so clicking the picture visibly did
      // something even when the controls are the other side of the window.
      flash.classList.remove('on')
      void flash.offsetWidth
      flash.classList.add('on')
    }

    const paintPlaying = () => {
      playBtn.replaceChildren(icon(video.paused ? 'play' : 'pause'))
      playBtn.setAttribute('aria-label', video.paused ? 'Play' : 'Pause')
      card.dataset.playing = String(!video.paused)
    }

    video.addEventListener('timeupdate', paintProgress)
    video.addEventListener('progress', paintProgress)
    video.addEventListener('play', paintPlaying)
    video.addEventListener('pause', paintPlaying)
    video.addEventListener('loadedmetadata', () => { paintProgress(); paintTicks() })
    video.addEventListener('ended', paintPlaying)

    const onKey = (event) => {
      if (event.key === 'Escape') { close(); return }
      // Not while the user is typing into something, and not for a shortcut
      // that belongs to the window rather than to this dialog.
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const keys = {
        ' ': () => toggle(),
        k: () => toggle(),
        ArrowLeft: () => { video.currentTime = Math.max(0, video.currentTime - 5) },
        ArrowRight: () => { video.currentTime = video.currentTime + 5 },
        j: () => { video.currentTime = Math.max(0, video.currentTime - 10) },
        l: () => { video.currentTime = video.currentTime + 10 },
        m: () => muteBtn.click(),
        f: () => fullBtn.click(),
        // Frame-stepping, for finding the exact moment something happened.
        ',': () => { video.pause(); video.currentTime = Math.max(0, video.currentTime - 1 / 30) },
        '.': () => { video.pause(); video.currentTime = video.currentTime + 1 / 30 }
      }
      const run = keys[event.key]
      if (!run) return
      event.preventDefault()
      run()
    }

    const close = () => {
      video.pause()
      removeEventListener('keydown', onKey, true)
      if (document.fullscreenElement) document.exitFullscreen?.()
      scrim.classList.add('leaving')
      scrim.addEventListener('animationend', () => scrim.remove(), { once: true })
      setTimeout(() => scrim.remove(), 400)
    }

    addEventListener('keydown', onKey, true)
    document.body.append(scrim)
    paintPlaying()
    paintProgress()
    paintTicks()
    playBtn.focus()
  }

  /* ─────────────────────────────────────────────────────────── deleting */

  /**
   * Delete the container when the last thing in it goes.
   *
   * A session that has been emptied by hand is a folder with nothing in it and
   * a row in the library that means nothing — deleting the only recording in a
   * session and still seeing the session listed is the app disagreeing with
   * what you just did. `pruneEmpty` in Settings exists for exactly these, which
   * is the app already agreeing they are litter; this just stops one being
   * created in the first place.
   *
   * The current session is not exempt. If it goes, the pointer is cleared and
   * the next capture starts a fresh one, rather than writing into a directory
   * that is no longer there.
   */
  async function dropIfEmpty() {
    if (!session) return false
    const sum = summarise(session)
    if (!sum.empty) return false

    const gone = session.id
    await api.library.remove(gone)
    await forgetSession(gone)
    openId = null
    session = null
    await loadSessions()
    return true
  }

  async function removeStep(step) {
    const ok = await confirm({
      title: `Delete step ${step.index}?`,
      body: `“${step.title}” will be removed from this session and deleted from disk. This cannot be undone.`,
      action: 'Delete step'
    })
    if (!ok) return

    session.steps = session.steps.filter((s) => s.id !== step.id)
    pickedSteps.delete(step.id)
    await api.library.removeAsset({ sessionId: session.id, name: step.file })
    await api.library.removeAsset({ sessionId: session.id, name: step.thumb })
    await api.library.save(session)

    const index = step.index
    // Deliberately not renumbered: the numbers are printed into exported
    // evidence, and silently making a different capture "step 7" rewrites what
    // an already-delivered PDF refers to. Closing the gap is a button.
    if (await dropIfEmpty()) {
      toast(`Step ${index} deleted — the session was empty, so it went too`, { tone: 'warn' })
      return
    }
    await openSession(session.id)
    toast(`Step ${index} deleted`, { tone: 'warn' })
  }

  async function removeTape(item) {
    const ok = await confirm({
      title: 'Delete this recording?',
      body: `${mmss(item.durationMs)} of video, ${humanBytes(item.bytes)}. It will be deleted from disk and cannot be recovered.`,
      action: 'Delete recording'
    })
    if (!ok) return

    session.media = session.media.filter((m) => m.id !== item.id)
    pickedTapes.delete(item.id)
    await api.library.removeAsset({ sessionId: session.id, name: item.file })
    await api.library.save(session)

    if (await dropIfEmpty()) {
      toast('Recording deleted — the session was empty, so it went too', { tone: 'warn' })
      return
    }
    await openSession(session.id)
    toast('Recording deleted', { tone: 'warn' })
  }

  async function doRenumber() {
    const renames = renumber(session)
    if (!renames.length) { toast('Already in order'); return }
    await api.library.renumber({ sessionId: session.id, renames })
    await api.library.save(session)
    await openSession(session.id)
    toast(`Renumbered ${session.steps.length} steps`)
  }

  /**
   * The name on the exports.
   *
   * A session is named after the moment it started — `20260903-142206` — which
   * sorts well and means nothing. The label is what the library lists, what the
   * title bar shows and what the exported files are called, and until now it
   * could only ever be empty: `ensureSession` passed `''` and nothing else ever
   * set it.
   *
   * Clearing it is a real answer, and puts the timestamp back.
   */
  async function renameSession() {
    const answer = await promptFor({
      title: 'Rename session',
      body: 'This is what the library lists and what exported files are named. Leave it empty to go back to the timestamp.',
      label: 'Name',
      value: session.label,
      placeholder: session.name,
      action: 'Rename'
    })
    if (answer === null) return

    session.label = answer
    await api.library.save(session)
    // The rail's card and the title bar both read the label, and this may be
    // the session they are showing.
    if (state.session?.id === session.id) state.session.label = answer
    await loadSessions()
    toast(answer ? `Renamed to “${answer}”` : 'Name cleared')
  }

  /**
   * Notes, which the export prints and nothing could write.
   *
   * `session.notes` has been in the model and in the Markdown report since the
   * first build — the report drops it in under the heading — but no screen ever
   * set it. A field the exporter prints and the app cannot fill is a promise
   * the product does not keep.
   */
  async function editNotes() {
    const answer = await promptFor({
      title: 'Session notes',
      body: 'Printed at the top of a Markdown export, under the heading. What the run was for, what was being reproduced, what to look at.',
      label: 'Notes',
      value: session.notes || '',
      placeholder: 'Reproducing the double-charge on checkout…',
      action: 'Save notes',
      multiline: true,
      maxLength: 2000
    })
    if (answer === null) return

    session.notes = answer
    await api.library.save(session)
    toast(answer ? 'Notes saved' : 'Notes cleared')
  }

  /**
   * A step's title is the heading on its PDF page.
   *
   * It is generated from the window the capture came from, which is a
   * reasonable guess and not a caption anybody chose — and it is what a
   * colleague reads at the top of the page.
   */
  async function renameStep(step) {
    const answer = await promptFor({
      title: `Rename step ${step.index}`,
      body: 'This is the heading on the step’s page in a PDF or Markdown export.',
      label: 'Title',
      value: step.title,
      placeholder: `Step ${step.index}`,
      action: 'Rename'
    })
    if (answer === null) return

    step.title = answer || `Step ${step.index}`
    await api.library.save(session)
    await openSession(session.id)
    toast('Step renamed')
  }

  /* ───────────────────────────────────────────────────────── annotating */

  /**
   * Mark up a capture, and burn the marks into the pixels.
   *
   * The burn-in is the whole point, and it follows the rule the cursor ring and
   * the keypress caps already follow: what gets attached to a ticket is the
   * PNG, so a marker that lives only in this app's viewer is not evidence.
   *
   * Which leaves undo, and this is where the two kinds of mark part company:
   *
   *   A box or an arrow keeps an untouched copy beside the file, so it can be
   *   taken back off. The copy is written once, on the first edit, and never
   *   overwritten — otherwise a second edit would "restore" to the first
   *   edit's output and the original would be gone without anyone saying so.
   *
   *   A redaction deletes that copy. That is what makes it a redaction rather
   *   than a sticker, and it is why the editor asks before saving one.
   *
   * The digest is recomputed either way, and the pre-edit digest is kept. A
   * pack that says "this image was altered after capture, here is what it
   * hashed to before and after" is honest; one that silently re-hashes and
   * claims the result is pristine is not.
   */
  async function annotateStep(step) {
    let bytes
    try {
      bytes = await api.library.readAsset({ sessionId: session.id, name: step.file })
    } catch {
      toast('That capture could not be read from disk', { tone: 'bad' })
      return
    }

    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    let suggestions = []
    if (state.settings.autoHighlight) suggestions = await suggestChanges(step)

    const marks = await openEditor({
      image,
      annotations: step.annotations || [],
      suggestions,
      settings: state.settings,
      title: `Step ${step.index}`
    })
    image.close?.()
    if (marks === null) return

    const destroys = hasRedaction(marks)
    try {
      // Keep the pristine copy before the first edit, and only then — a later
      // edit must not overwrite it with an already-annotated image.
      const orig = originalName(step.file)
      if (!step.annotations?.length && !destroys) {
        await api.library.writeAsset({ sessionId: session.id, name: orig, data: bytes })
      }

      const png = await burnAnnotations(bytes, marks)
      await api.library.writeAsset({ sessionId: session.id, name: step.file, data: png })
      await api.library.writeAsset({
        sessionId: session.id, name: step.thumb, data: await thumbnail(png, 480)
      })

      // Gone for good, which is the difference between this and a blur.
      if (destroys) await api.library.removeAsset({ sessionId: session.id, name: orig })

      step.annotations = marks
      step.bytes = png.byteLength
      if (state.settings.hashAssets) {
        // The digest from before the first edit, kept once and not moved by
        // later ones, so it always refers to what came out of the camera.
        if (!step.originalSha256) step.originalSha256 = step.sha256
        step.sha256 = await digest(png)
      }
      await api.library.save(session)
      await openSession(session.id)

      toast(marks.length
        ? `${describeMarks(marks)}${destroys ? ' · original destroyed' : ''}`
        : 'Marks cleared')
    } catch (err) {
      toast(String(err?.message || err), { tone: 'bad' })
    }
  }

  /**
   * Candidate boxes around whatever changed since the previous step.
   *
   * Run against the thumbnails rather than the originals: a 480px copy is
   * plenty to locate a changed region and roughly sixty times less work than
   * two 4K decodes, and the result is scaled back up to the full image. A
   * failure here is not worth reporting — the editor simply opens with no
   * suggestions, which is how it behaves for the first step in a session
   * anyway.
   */
  async function suggestChanges(step) {
    const at = session.steps.findIndex((s) => s.id === step.id)
    const previous = session.steps[at - 1]
    if (!previous) return []

    try {
      const [before, after] = await Promise.all([
        pixels(previous.thumb),
        pixels(step.thumb)
      ])
      if (!before || !after || before.width !== after.width || before.height !== after.height) return []

      const found = diffRegions(before.data, after.data, { width: before.width, height: before.height })
      return scaleRegions(found, before, { width: step.width, height: step.height })
    } catch {
      return []
    }
  }

  /** A thumbnail decoded to RGBA, which is what the differ compares. */
  async function pixels(name) {
    const bytes = await api.library.readAsset({ sessionId: session.id, name })
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    try {
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(image, 0, 0)
      const { data } = ctx.getImageData(0, 0, image.width, image.height)
      return { data, width: image.width, height: image.height }
    } finally {
      image.close?.()
    }
  }

  /* ──────────────────────────────────────────────────────────── integrity */

  /**
   * Re-hash everything in this session and say whether it still matches.
   *
   * The local half of the manifest story. An export ships digests so whoever
   * receives it can check the pack; this answers the same question about the
   * library itself, which catches a file edited in place by another program, a
   * half-restored backup, or a sync client that resolved a conflict badly.
   *
   * The work happens in main — it reads every asset, and streaming several
   * hundred megabytes of video through IPC so the page could hash it would be
   * slower and pointless when the answer is a verdict.
   */
  async function verify() {
    const button = headActions.querySelector('[data-act="verify"]')
    if (button) { button.disabled = true; button.lastChild.textContent = 'Checking…' }
    try {
      const result = await api.library.verify(session.id)
      if (!result) { toast('That session could not be read', { tone: 'bad' }); return }

      if (result.intact) {
        toast(`Intact — ${describeVerification(result)}`)
        return
      }
      if (result.unverified.length && !result.modified.length && !result.missing.length) {
        // Captured before hashing existed, or with it switched off. Not a
        // finding: no digest is a different thing from a wrong one.
        toast(`${result.unverified.length} file${result.unverified.length === 1 ? '' : 's'} were stored without a digest and cannot be checked`, { tone: 'warn' })
        return
      }
      const names = [...result.modified, ...result.missing].slice(0, 3).join(', ')
      toast(`${describeVerification(result)} — ${names}${result.modified.length + result.missing.length > 3 ? '…' : ''}`, {
        tone: 'bad', timeout: 9000
      })
    } catch (err) {
      toast(String(err?.message || err), { tone: 'bad' })
    } finally {
      if (button) { button.disabled = false; button.lastChild.textContent = 'Verify' }
    }
  }

  /* ────────────────────────────────────────────── steps from a recording */

  /**
   * Cut a recording into numbered steps at the actions it recorded.
   *
   * The app already recorded the video and already ran an input hook during the
   * take; this is the join between them. Each planned action seeks the video to
   * a moment just before it happened, draws that frame, and stores it as an
   * ordinary step — so everything downstream (annotating, exporting, the PDF,
   * the manifest) works on them without knowing where they came from.
   *
   * Never automatic. Sixty steps appearing in the library unasked is not a
   * feature, so this is a button, it says how many it will produce before it
   * runs, and it asks.
   */
  async function extractSteps(item) {
    const plan = planSteps(item.marks || [], {
      startedAt: item.startedAt,
      durationMs: item.durationMs,
      pauses: item.pauses || []
    }, {
      max: state.settings.autoStepsMax,
      clicksOnly: state.settings.autoStepsOn === 'clicks'
    })

    if (!plan.length) {
      toast(item.marks?.length
        ? 'No actions in this recording could be placed on a frame'
        : 'This recording was taken without action tracking', { tone: 'warn' })
      return
    }

    const ok = await confirm({
      title: 'Make steps from this recording?',
      body: `${describePlan(plan)}. Each becomes a numbered capture in this session, taken from the frame just before the action. The recording is not changed.`,
      action: `Make ${plan.length} step${plan.length === 1 ? '' : 's'}`,
      tone: 'ok',
      glyph: 'layers'
    })
    if (!ok) return

    const bytes = await api.library.readAsset({ sessionId: session.id, name: item.file })
    const src = url(bytes, item.mimeType || 'video/webm')
    const video = el('video', { src, muted: true, preload: 'auto' })

    let made = 0
    try {
      await new Promise((resolve, reject) => {
        video.addEventListener('loadeddata', resolve, { once: true })
        video.addEventListener('error', () => reject(new Error('That recording could not be decoded.')), { once: true })
      })

      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth || item.width
      canvas.height = video.videoHeight || item.height
      const ctx = canvas.getContext('2d')

      for (const mark of plan) {
        // Sequentially, and awaiting each seek: a video element has one
        // playhead, so firing these in parallel means every frame is whichever
        // seek happened to land last.
        await seek(video, mark.offsetMs / 1000)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
        const data = new Uint8Array(await png.arrayBuffer())

        const entry = addStep(session, {
          title: `${mark.label}`,
          mode: 'video',
          width: canvas.width,
          height: canvas.height,
          bytes: data.byteLength,
          capturedAt: mark.at,
          source: item.source,
          // Where it came from, so a step pulled out of a take is traceable to
          // the take and the moment rather than looking like a screenshot.
          from: { mediaId: item.id, offsetMs: mark.offsetMs, kind: mark.kind },
          sha256: state.settings.hashAssets ? await digest(data) : null
        })
        await api.library.writeAsset({ sessionId: session.id, name: entry.file, data })
        await api.library.writeAsset({
          sessionId: session.id, name: entry.thumb, data: await thumbnail(data, 480)
        })
        made++
      }

      await api.library.save(session)
      await openSession(session.id)
      toast(`${made} step${made === 1 ? '' : 's'} made from the recording`)
    } catch (err) {
      // Whatever was extracted before the failure is kept rather than rolled
      // back — half a document is more use than none, and the steps that did
      // land are correct.
      if (made) await api.library.save(session).catch(() => {})
      await openSession(session.id).catch(() => {})
      toast(String(err?.message || err), { tone: 'bad' })
    } finally {
      video.removeAttribute('src')
      video.load()
    }
  }

  /**
   * One seek, resolved when the frame is there to be drawn.
   *
   * Known limitation: `seeked` says the seek *completed*, not that the decoded
   * frame is what the next `drawImage` will copy. Measured at roughly one run
   * in three, two extractions two seconds apart come back holding the same
   * picture — the step is written and looks complete, it just shows the wrong
   * frame. MediaRecorder output makes it likelier: a WebM written in
   * timeslices carries no seek index, so a seek is an estimate.
   *
   * `requestVideoFrameCallback` is the right primitive — it fires when a frame
   * has been presented — but waiting on it here hangs every seek instead, so
   * it is not simply a drop-in. Left as-is rather than shipped half-fixed; a
   * wrong frame occasionally is worse than the status quo only if you cannot
   * tell, and `npm run probe` tells.
   */
  function seek(video, seconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The recording stopped responding while seeking.')), 8000)
      const done = () => { clearTimeout(timer); resolve() }
      video.addEventListener('seeked', done, { once: true })
      video.currentTime = seconds
    })
  }

  /**
   * Deleting a whole session asks in a dialog.
   *
   * It used to arm the button in place — one click turned it into
   * "Delete — sure?" and the next did it. The second click lands on the same
   * pixels as the first, so a double-click deleted a session without ever
   * showing the question.
   */
  async function doDeleteSession() {
    const sum = summarise(session)
    const holds = [
      sum.steps ? `${sum.steps} step${sum.steps === 1 ? '' : 's'}` : null,
      sum.media ? `${sum.media} recording${sum.media === 1 ? '' : 's'}` : null
    ].filter(Boolean).join(' and ') || 'nothing'

    const ok = await confirm({
      title: `Delete “${session.label || session.name}”?`,
      body: `This session holds ${holds}, ${humanBytes(sum.bytes)} in total. The whole folder is deleted from disk and cannot be recovered.`,
      action: 'Delete session'
    })
    if (!ok) return

    const gone = session.id
    await api.library.remove(gone)
    // Clearing the pointer is not enough on its own — the rail's card is
    // painted from it, and without a repaint it kept showing the name and the
    // step count of a folder that had gone.
    await forgetSession(gone)
    openId = null
    session = null
    await loadSessions()
    toast('Session deleted', { tone: 'warn' })
  }

  /* ──────────────────────────────────────────────────────────── exporting */

  const chosenSteps = () => session.steps.filter((s) => pickedSteps.has(s.id))
  const chosenTapes = () => session.media.filter((m) => pickedTapes.has(m.id))

  function paintDock() {
    if (!session) { dock.hidden = true; return }
    dock.hidden = !session.steps.length && !session.media.length

    for (const node of formats.children) {
      node.setAttribute('aria-pressed', String(node.dataset.fmt === format))
    }

    const steps = chosenSteps()
    const tapesPicked = chosenTapes()
    const isVideo = format === 'video'
    const count = isVideo ? tapesPicked.length : steps.length
    const bytes = estimate(format, steps, tapesPicked)

    exportBtn.disabled = count === 0
    exportBtn.lastElementChild.textContent = count === 0
      ? (isVideo
        ? (session.media.length ? 'Select a recording' : 'Nothing recorded yet')
        : 'Select at least one step')
      : isVideo
        ? `Export ${count} recording${count === 1 ? '' : 's'} · ${humanBytes(bytes)}`
        : `Export ${count} step${count === 1 ? '' : 's'} · ${humanBytes(bytes)}`

    dockHint.textContent = {
      pdf: 'One step per page, numbered, with its metadata.',
      png: steps.length === 1 ? 'A single PNG.' : 'A zip of numbered PNGs.',
      md: 'A zip: report.md and a steps/ folder.',
      video: 'Each ticked recording as its own file.'
    }[format]

    if (session.steps.length) {
      stepsRule.lastElementChild.textContent =
        pickedSteps.size === session.steps.length ? 'Clear' : 'Select all'
    }
  }

  const read = (name) => api.library.readAsset({ sessionId: session.id, name })

  async function run(format, steps, media) {
    const many = format === 'video' && media.length > 1
    const name = outputName(format, session, { steps, media })
    const path = await api.exporter.pick({ name, kind: many ? 'folder' : 'file' })
    if (!path) return

    const label = exportBtn.lastElementChild
    const original = label.textContent
    exportBtn.disabled = true
    try {
      const plan = await buildExport(format, {
        session,
        steps,
        media,
        read,
        toJpeg,
        includeMeta: state.settings.includeMeta,
        machine: steps[0]?.meta || media[0]?.meta || {},
        // Only the zip formats can carry it; the others ignore the flag rather
        // than writing a loose checksum file next to whatever the user picked.
        manifest: state.settings.exportManifest,
        onProgress: (done, total) => { label.textContent = `Rendering ${done}/${total}…` }
      })
      const written = await api.exporter.write({ path, files: plan.files })
      toast(`Exported ${written.length} file${written.length === 1 ? '' : 's'}`, {
        action: 'Show', onAction: () => api.shell.reveal(written[0])
      })
    } catch (err) {
      toast(String(err?.message || err), { tone: 'bad' })
    } finally {
      label.textContent = original
      exportBtn.disabled = false
      paintDock()
    }
  }

  exportBtn.addEventListener('click', () => {
    run(format, chosenSteps(), chosenTapes())
  })

  /** One row's own download, without going near the format picker. */
  const exportOne = (item) => run('video', [], [item])

  /**
   * Land on the thing that was just made.
   *
   * Called with `{ sessionId, mediaId, stepId }` by whoever navigated here —
   * finishing a recording, mostly. Opening the right session is the important
   * half; the flash is the other half, because a session that already holds
   * nine takes does not answer "where is the one I just recorded" by simply
   * being open.
   *
   * Everything here degrades to a no-op: an id that is no longer in the list
   * just leaves the library as it was, rather than failing on the way back
   * from a recording.
   */
  async function reveal(focus) {
    if (!focus) return
    const target = focus.mediaId
      ? tapes.querySelector(`[data-id="${CSS.escape(focus.mediaId)}"]`)
      : focus.stepId
        ? shots.querySelector(`[data-id="${CSS.escape(focus.stepId)}"]`)
        : null
    if (!target) return

    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // Removed and re-added rather than toggled, so arriving twice on the same
    // row plays the animation again instead of doing nothing.
    target.classList.remove('landed')
    void target.offsetWidth
    target.classList.add('landed')
    target.addEventListener('animationend', () => target.classList.remove('landed'), { once: true })
  }

  return {
    async enter(focus) {
      // Settings may have changed the default since this view was last opened.
      format = state.settings?.exportFormat || format
      // Asked for before the list is read, so the session holding it opens
      // rather than whichever one happened to be open last.
      if (focus?.sessionId) openId = focus.sessionId
      await loadSessions()
      await reveal(focus)
    }
  }
}
