/**
 * The Capture view.
 *
 * Three modes, and a picker that shows you what you are about to photograph.
 * A screenshot tool that asks "which window?" with a list of process names is
 * asking a question most people cannot answer — `Chrome_WidgetWin_1` is not how
 * anyone thinks about the thing on their screen. The thumbnail is the answer,
 * so the picker is a grid of live previews and the process name is only the
 * caption.
 */

import { el, icon, toast, humanBytes } from './ui.js'
import { watchSources } from './watch.js'
import { state, storeShot, setPhase, go, refreshView } from './app.js'

export function mountCapture({ root, api }) {
  const sources = el('div.sources')
  const sourceCard = el('div.card', {}, [
    el('h2', { text: 'What to capture' }),
    el('p.sub', { text: 'Pick a display or a window. Previews refresh when you open this view.' }),
    sources
  ])

  const modes = el('div.seg', { role: 'group', 'aria-label': 'Capture mode' }, [
    modeButton('screen', 'monitor', 'Whole display'),
    modeButton('window', 'window', 'A window'),
    modeButton('region', 'crop', 'Region')
  ])

  const countdownOut = el('output', { text: '0s' })
  const countdown = el('input', {
    type: 'range', min: '0', max: '10', step: '1', value: '0', 'aria-label': 'Countdown'
  })

  const shutterBtn = el('button.cta', { type: 'button' }, [icon('camera'), el('span')])
  const hint = el('span.hint')

  const optionsCard = el('div.card', {}, [
    el('h2', { text: 'Options' }),
    el('p.sub', { text: 'These apply to every capture, however it is triggered.' }),
    el('div.rows', {}, [
      toggleRow('markCursor', 'cursor', 'Mark the pointer',
        'Draws a ring where the cursor was, into the image itself.'),
      toggleRow('hideOnCapture', 'eye', 'Hide this window',
        'Rebind Capture gets out of the way before the shutter, so it is never in the shot.'),
      toggleRow('copyToClipboard', 'file', 'Copy to clipboard',
        'As well as saving it to the session.'),
      toggleRow('sound', 'speaker', 'Shutter sound', null),
      toggleRow('metadata', 'shield', 'Attach metadata',
        'Display, scale factor, OS and timestamp, stored beside the image.')
    ])
  ])

  const delayCard = el('div.card', {}, [
    el('h2', { text: 'Delay' }),
    el('p.sub', { text: 'Seconds before the shutter, so a menu or a hover state can be opened first.' }),
    el('div.slider', {}, [countdown, countdownOut])
  ])

  // The shutter is the point of the view, so it is a pinned footer rather than
  // something you scroll to find.
  root.classList.add('split')
  root.append(
    el('div.scroller', {}, [
      el('div.view-head', {}, [
        el('div.body', {}, [
          el('h1', { text: 'Capture' }),
          el('p', {
            text: 'Take a numbered, timestamped shot of a display, a window, or a rectangle you drag out. Every capture lands in the current session.'
          })
        ]),
        el('div.actions', {}, [
          el('button.btn', { type: 'button', onClick: () => loadSources() }, [icon('refresh'), 'Refresh'])
        ])
      ]),
      el('div.grid-2', {}, [
        el('div', {}, [modes, el('div', { style: { height: '14px' } }), sourceCard]),
        el('div', {}, [optionsCard, el('div', { style: { height: '14px' } }), delayCard])
      ])
    ]),
    el('div.dock', {}, [
      el('div.dock-inner', {}, [
        el('div.dock-context', {}, [hint]),
        el('div.dock-action', {}, [shutterBtn])
      ])
    ])
  )

  /* ─────────────────────────────────────────────────────────── controls */

  function modeButton(mode, glyph, label) {
    return el('button', {
      type: 'button', dataset: { mode }, 'aria-pressed': 'false',
      onClick: () => set({ captureMode: mode })
    }, [icon(glyph), label])
  }

  function toggleRow(key, glyph, label, sub) {
    const sw = el('button.switch', {
      type: 'button', role: 'switch', 'aria-checked': 'false',
      'aria-label': label, dataset: { setting: key },
      onClick: () => set({ [key]: sw.getAttribute('aria-checked') !== 'true' })
    })
    return el('div.row', {}, [
      icon(glyph),
      el('span.body', {}, [
        el('span.label', { text: label }),
        sub ? el('span.sub', { text: sub }) : null
      ]),
      sw
    ])
  }

  const set = async (patch) => {
    state.settings = await api.settings.write(patch)
    paint()
  }

  countdown.addEventListener('input', () => { countdownOut.textContent = `${countdown.value}s` })
  countdown.addEventListener('change', () => set({ countdown: Number(countdown.value) }))

  /* ──────────────────────────────────────────────────────────── sources */

  let chosen = { screen: null, window: null }
  let loading = false

  async function loadSources() {
    if (loading) return
    loading = true
    sources.replaceChildren(el('p.sub', { text: 'Looking…', style: { gridColumn: '1 / -1' } }))
    try {
      const mode = state.settings.captureMode
      const kinds = mode === 'window' ? ['window'] : ['screen']
      const found = await api.shot.sources(kinds)
      paintSources(found, mode)
    } catch (err) {
      sources.replaceChildren(el('div.note.bad', { style: { gridColumn: '1 / -1' } }, [
        icon('alert'), el('span', { text: String(err?.message || err) })
      ]))
    } finally {
      loading = false
    }
  }

  function paintSources(found, mode) {
    if (!found.length) {
      sources.replaceChildren(el('div.empty', { style: { gridColumn: '1 / -1' } }, [
        el('span.glyph', {}, [icon('window')]),
        el('b', { text: 'Nothing to capture' }),
        el('div', { text: mode === 'window' ? 'No open windows were found.' : 'No displays were reported.' })
      ]))
      return
    }

    // A region is dragged out on whichever screen the pointer is on, so there
    // is nothing to pick — showing a picker here would imply otherwise.
    const key = mode === 'window' ? 'window' : 'screen'
    watcher.prime(found)
    if (!chosen[key] || !found.some((s) => s.id === chosen[key])) chosen[key] = found[0].id

    sources.replaceChildren(...found.map((source) => {
      const tile = el('button.source', {
        type: 'button',
        'aria-pressed': String(source.id === chosen[key]),
        title: source.name,
        onClick: () => {
          chosen[key] = source.id
          for (const node of sources.children) {
            node.setAttribute('aria-pressed', String(node.dataset.id === source.id))
          }
        }
      }, [
        el('span.frame', {}, [
          source.thumbnail
            ? el('img', { src: source.thumbnail, alt: '' })
            : el('span.none', { text: 'No preview' })
        ]),
        el('span.meta', {}, [
          source.icon ? el('img', { src: source.icon, alt: '' }) : icon(source.kind === 'screen' ? 'monitor' : 'window'),
          el('span', { text: source.name })
        ]),
        el('span.tick', {}, [icon('check')])
      ])
      tile.dataset.id = source.id
      // The display this source is, straight from `desktopCapturer` — the only
      // reliable link between a picked tile and a display.
      if (source.displayId) tile.dataset.displayId = String(source.displayId)
      return tile
    }))
  }

  /* ──────────────────────────────────────────────────────────── shutter */

  shutterBtn.addEventListener('click', async () => {
    const mode = state.settings.captureMode
    shutterBtn.disabled = true
    setPhase('busy')
    try {
      const shot = mode === 'region'
        ? await api.shot.region()
        : mode === 'window'
          ? await api.shot.window({ sourceId: chosen.window })
          : await api.shot.screen({ displayId: displayOf(chosen.screen) })

      // A cancelled region drag is not a failure and should say nothing.
      if (!shot) return

      const entry = await storeShot(shot)
      toast(`Step ${entry.index} · ${shot.width}×${shot.height} · ${humanBytes(entry.bytes)}`, {
        action: 'Library', onAction: () => go('library')
      })
      refreshView('library')
    } catch (err) {
      toast(String(err?.message || err), { tone: 'bad' })
    } finally {
      shutterBtn.disabled = false
      setPhase('ready')
      paint()
    }
  })

  /**
   * The picker reports Electron's source id; the capture wants a display id.
   *
   * Read off the tile, which carries the `display_id` the source itself
   * reported. This used to correlate the two by *index* — the nth entry from
   * `desktopCapturer.getSources()` against the nth from `screen.getAllDisplays()`
   * — and those two lists have no guaranteed common order. On a single screen
   * it worked by accident; plug in a monitor and picking "Screen 2" captured
   * Screen 1, which reads exactly like not being able to switch screens at all.
   *
   * Undefined rather than a guess when the id is missing: the capture then falls
   * back to the display the pointer is on, which is at least a defensible
   * answer, instead of confidently shooting the wrong monitor.
   */
  const displayOf = (sourceId) => {
    const tile = [...sources.children].find((n) => n.dataset.id === sourceId)
    const id = Number(tile?.dataset.displayId)
    return Number.isFinite(id) && id !== 0 ? id : undefined
  }

  /* ─────────────────────────────────────────────────────────── painting */

  function paint() {
    const settings = state.settings
    for (const node of modes.children) {
      node.setAttribute('aria-pressed', String(node.dataset.mode === settings.captureMode))
    }
    for (const node of root.querySelectorAll('[data-setting]')) {
      node.setAttribute('aria-checked', String(Boolean(settings[node.dataset.setting])))
    }
    countdown.value = String(settings.countdown)
    countdownOut.textContent = `${settings.countdown}s`

    const mode = settings.captureMode
    sourceCard.hidden = mode === 'region'
    shutterBtn.lastElementChild.textContent = {
      screen: 'Capture display', window: 'Capture window', region: 'Drag out a region'
    }[mode]

    const combo = {
      screen: state.settings.hotkeys.captureScreen,
      window: state.settings.hotkeys.captureWindow,
      region: state.settings.hotkeys.captureRegion
    }[mode]
    hint.textContent = combo
      ? `${pretty(combo)} works anywhere, even with this window closed`
      : 'No global shortcut is bound for this mode'
  }

  /**
   * Repaint when a window the picker is offering disappears.
   *
   * Only the tiles change — the chosen source is kept if it is still there, so
   * a background window closing does not move the user's selection.
   */
  const watcher = watchSources({
    fetch: () => api.shot.sources(state.settings.captureMode === 'window' ? ['window'] : ['screen']),
    onChange: (found) => paintSources(found, state.settings.captureMode)
  })

  return {
    async enter() {
      paint()
      await loadSources()
      watcher.start()
    }
  }
}

/** Platform-appropriate rendering of an Electron accelerator. */
function pretty(combo) {
  const mac = navigator.platform.toLowerCase().includes('mac')
  return combo
    .replace(/CommandOrControl|CmdOrCtrl/g, mac ? '⌘' : 'Ctrl')
    .replace(/Alt/g, mac ? '⌥' : 'Alt')
    .replace(/Shift/g, mac ? '⇧' : 'Shift')
    .split('+')
    .join(mac ? '' : ' + ')
}
