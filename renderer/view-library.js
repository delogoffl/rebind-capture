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

import { el, icon, toast, mmss, humanBytes, when, bytesToUrl, toJpeg } from './ui.js'
import { state, refreshSessions, forgetSession, go } from './app.js'
import { buildExport, estimate, outputName } from '../lib/export.js'
import { renumber, summarise } from '../lib/session.js'

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

      const tile = el('button.shot', {
        type: 'button',
        'aria-pressed': String(pickedSteps.has(step.id)),
        title: step.title,
        onClick: (event) => {
          if (event.altKey) { removeStep(step); return }
          if (pickedSteps.has(step.id)) pickedSteps.delete(step.id)
          else pickedSteps.add(step.id)
          tile.setAttribute('aria-pressed', String(pickedSteps.has(step.id)))
          paintDock()
        }
      }, [
        src ? el('img', { src, alt: step.title, loading: 'lazy' }) : el('div', { style: { aspectRatio: '16/10' } }),
        el('span.n', { text: String(step.index) }),
        el('span.tick', {}, [icon('check')]),
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
      const row = el('div.tape', { dataset: { on: String(pickedTapes.has(item.id)) } })

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
      ]), grab, remove)
      return row
    }))
  }

  /** In a real window, because a video has to outlive the click that opened it. */
  async function playTape(item) {
    const bytes = await api.library.readAsset({ sessionId: session.id, name: item.file })
    const src = url(bytes, item.mimeType || 'video/webm')
    const overlay = el('div', {
      style: {
        position: 'fixed', inset: '0', zIndex: '60', display: 'grid', placeItems: 'center',
        background: 'rgba(4, 7, 14, .82)', backdropFilter: 'blur(8px)'
      },
      onClick: (event) => { if (event.target === overlay) close() }
    })
    const video = el('video', {
      src, controls: true, autoplay: true,
      style: { maxWidth: '86vw', maxHeight: '80vh', borderRadius: '14px', boxShadow: 'var(--pop)' }
    })
    const close = () => { video.pause(); overlay.remove(); removeEventListener('keydown', onKey) }
    const onKey = (event) => { if (event.key === 'Escape') close() }
    addEventListener('keydown', onKey)
    overlay.append(video)
    document.body.append(overlay)
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

  let armed = null
  async function doDeleteSession() {
    const button = headActions.lastElementChild
    if (armed !== session.id) {
      armed = session.id
      button.lastChild.textContent = 'Delete — sure?'
      setTimeout(() => {
        if (armed !== session.id) return
        armed = null
        button.lastChild.textContent = 'Delete session'
      }, 3200)
      return
    }
    armed = null
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

  return {
    async enter() {
      // Settings may have changed the default since this view was last opened.
      format = state.settings?.exportFormat || format
      await loadSessions()
    }
  }
}
