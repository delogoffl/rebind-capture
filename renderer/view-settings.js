/**
 * Settings — all of them, in one place.
 *
 * This used to surface six of the twenty-one settings the app actually has.
 * The rest lived only in the view that used them, or in the case of `countIn`
 * nowhere at all: defined in the defaults, validated on read, written to disk,
 * and never once read. A settings page that is a subset of the settings is
 * worse than no settings page, because it teaches people that what they are
 * looking for is not there.
 *
 * So the rows are a declarative spec rather than hand-built markup. Adding a
 * setting is one entry in `SECTIONS`, which is what keeps the page and the
 * defaults from drifting apart again — and a test walks the two and fails if
 * anything in `DEFAULTS` has no row.
 *
 * The section list on the left is the desktop convention for a page this long,
 * and it doubles as a table of contents: seven headings is more than anyone
 * scrolls through looking for one switch.
 */

import { el, icon, toast, humanBytes } from './ui.js'
import { state, applyTheme } from './app.js'
import { DEFAULTS, isAccelerator, conflicts, prettyHotkey } from '../lib/settings.js'

const ACTIONS = {
  captureScreen: 'Capture display',
  captureWindow: 'Capture window',
  captureRegion: 'Capture region',
  toggleRecording: 'Start / stop recording',
  pauseRecording: 'Pause / resume recording'
}

/**
 * Every setting, and where it belongs.
 *
 * `key` names the setting in `lib/settings.js`. Anything without a key is a
 * control that is not a stored value — the shortcut table, the library actions,
 * the about rows.
 */
const SECTIONS = [
  {
    id: 'appearance',
    title: 'Appearance',
    glyph: 'sun',
    blurb: 'The accent moves the product colour only. Nothing that carries meaning — a recording, a warning, a capture — moves with it.',
    rows: [
      { kind: 'seg', key: 'theme', label: 'Theme', options: [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']] },
      { kind: 'swatch', key: 'accent', label: 'Accent', options: ['indigo', 'cyan', 'violet', 'emerald', 'amber', 'rose'] }
    ]
  },
  {
    id: 'capture',
    title: 'Capture',
    glyph: 'camera',
    blurb: 'These apply to every capture, whether it came from the button or from a global shortcut.',
    rows: [
      {
        kind: 'slider', key: 'countdown', glyph: 'clock', label: 'Delay before the shutter',
        sub: 'Seconds, so a menu or a hover state can be opened first.',
        min: 0, max: 10, step: 1, unit: 's'
      },
      {
        kind: 'toggle', key: 'markCursor', glyph: 'cursor', label: 'Mark the pointer',
        sub: 'Draws a ring where the cursor was — into the image itself, so it survives every export.'
      },
      { kind: 'swatch', key: 'cursorColor', label: 'Marker colour', options: ['cyan', 'indigo', 'amber', 'red', 'green'], needs: 'markCursor' },
      { kind: 'seg', key: 'cursorSize', label: 'Marker size', options: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']], needs: 'markCursor' },
      {
        kind: 'toggle', key: 'hideOnCapture', glyph: 'eye', label: 'Hide this window first',
        sub: 'Rebind Capture gets out of the way before the shutter, so it is never in its own screenshot.'
      },
      {
        kind: 'toggle', key: 'copyToClipboard', glyph: 'file', label: 'Copy to clipboard',
        sub: 'As well as saving it to the session.'
      },
      { kind: 'toggle', key: 'sound', glyph: 'speaker', label: 'Shutter sound' },
      {
        kind: 'toggle', key: 'metadata', glyph: 'shield', label: 'Attach metadata',
        sub: 'Display, scale factor, OS and timestamp, stored beside the image and printed into exports.'
      }
    ]
  },
  {
    id: 'recording',
    title: 'Recording',
    glyph: 'record',
    blurb: 'Quality costs disk: 30 fps at 8 Mbps is roughly 60 MB a minute at 1080p.',
    rows: [
      {
        kind: 'slider', key: 'countIn', glyph: 'clock', label: 'Count in',
        sub: 'Seconds between pressing record and the first frame, so you can get to the window first.',
        min: 0, max: 10, step: 1, unit: 's'
      },
      { kind: 'slider', key: 'fps', glyph: 'gauge', label: 'Frame rate', min: 10, max: 60, step: 5, unit: ' fps' },
      { kind: 'slider', key: 'bitrate', glyph: 'gauge', label: 'Bitrate', min: 1, max: 40, step: 1, unit: ' Mbps' },
      {
        kind: 'toggle', key: 'recordAudio', glyph: 'speaker', label: 'System audio',
        sub: 'What the machine is playing. Not available for every source.'
      },
      {
        kind: 'toggle', key: 'recordMic', glyph: 'mic', label: 'Microphone',
        sub: 'Narration, with echo cancellation and noise suppression on.'
      },
      {
        kind: 'toggle', key: 'minimizeOnRecord', glyph: 'eye', label: 'Minimise while recording',
        sub: 'The app gets out of the way when a take starts, and comes back when it stops. The transport is a separate always-on-top window, so it stays.'
      },
      {
        kind: 'toggle', key: 'recorderBar', glyph: 'bolt', label: 'Floating transport',
        sub: 'Elapsed time, pause and stop, on top of every application and on every workspace.'
      },
      {
        kind: 'toggle', key: 'protectBar', glyph: 'shield', label: 'Keep the transport out of the recording',
        sub: 'The compositor is told to exclude that window from any capture.',
        needs: 'recorderBar',
        /** Named at render time, because the answer is a platform fact. */
        unsupported: (info) => (info?.canProtect === false
          ? 'This platform cannot exclude a window from a capture. Record a single window to keep the transport out of the frame.'
          : null)
      }
    ]
  },
  {
    id: 'keypress',
    title: 'Keypress display',
    glyph: 'keyboard',
    blurb: 'Draws the keys you press into the capture, so a screenshot shows what was typed and not only what it did. It has to watch the keyboard system-wide, which is why it is off until you turn it on.',
    rows: [
      {
        kind: 'toggle', key: 'keypress', glyph: 'keyboard', label: 'Show keypresses',
        sub: 'A strip of keycaps on screen while you work, drawn into every capture you take.',
        // The one setting whose availability is a platform fact rather than a
        // preference, so the only one that can refuse to turn on.
        unsupported: (info) => (info?.keys && info.keys.available === false
          ? `The input hook is not available here${info.keys.reason ? ` — ${info.keys.reason}` : ''}.`
          : null)
      },
      {
        kind: 'seg', key: 'keypressWhen', label: 'Watch the keyboard', needs: 'keypress',
        options: [['recording', 'Only while recording'], ['always', 'Whenever the app is open']],
        sub: 'Only while recording is the default: the hook starts with a take and stops with it. Watching all the time is what puts keys into screenshots too, and means the keyboard is being read for as long as the app is running.'
      },
      {
        kind: 'corner', key: 'keypressPosition', label: 'Corner', needs: 'keypress',
        sub: 'Where the strip sits in the frame. It ends up in the picture, so keep it off whatever the capture is about.'
      },
      {
        kind: 'seg', key: 'keypressSize', label: 'Size', needs: 'keypress',
        options: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large'], ['xl', 'Huge']]
      },
      {
        kind: 'seg', key: 'keypressTheme', label: 'Key style', needs: 'keypress',
        options: [['dark', 'Dark'], ['light', 'Light'], ['accent', 'Accent']]
      },
      {
        kind: 'slider', key: 'keypressHold', glyph: 'clock', label: 'Hold on screen',
        sub: 'Seconds a key stays before it fades. Longer survives a slower capture.',
        min: 0.5, max: 10, step: 0.5, unit: 's', needs: 'keypress'
      },
      {
        kind: 'toggle', key: 'keypressMask', glyph: 'eye', label: 'Mask typed characters',
        sub: 'Shows dots instead of the letters. Modifiers and named keys still show, so a password never lands in the evidence while the fact that something was typed still does.',
        needs: 'keypress'
      }
    ]
  },
  {
    id: 'export',
    title: 'Export',
    glyph: 'download',
    blurb: 'Defaults for the export dock. Both can still be changed per export.',
    rows: [
      {
        kind: 'seg', key: 'exportFormat', label: 'Default format',
        options: [['pdf', 'PDF'], ['png', 'PNG'], ['md', 'Markdown'], ['video', 'Video']]
      },
      {
        kind: 'toggle', key: 'includeMeta', glyph: 'tag', label: 'Include metadata in exports',
        sub: 'YAML front matter in the Markdown report, and the facts line under each PDF page.'
      },
      {
        kind: 'toggle', key: 'exportManifest', glyph: 'shield', label: 'Ship an integrity manifest',
        sub: 'manifest.json and SHA256SUMS inside zip exports, so a recipient can check the pack with sha256sum. Single-file exports have nowhere to put it.',
        needs: 'hashAssets'
      }
    ]
  },
  {
    id: 'evidence',
    title: 'Evidence',
    glyph: 'shield',
    blurb: 'What makes an export checkable rather than merely tidy. None of this proves where a screenshot came from — no offline tool can — but it makes alteration after the fact visible.',
    rows: [
      {
        kind: 'toggle', key: 'hashAssets', glyph: 'shield', label: 'Hash every capture',
        sub: 'A SHA-256 recorded the moment the file is written, which is what Verify and the export manifest compare against later. Costs a hash of a few megabytes per capture.'
      },
      {
        kind: 'toggle', key: 'autoHighlight', glyph: 'crop', label: 'Suggest what changed',
        sub: 'When marking up a capture, offer dashed boxes around whatever differs from the previous step. A suggestion only — nothing is drawn until you click one.'
      },
      {
        kind: 'swatch', key: 'annotateColor', label: 'Default mark colour',
        options: ['red', 'amber', 'green', 'cyan', 'indigo']
      },
      {
        kind: 'seg', key: 'annotateWeight', label: 'Default stroke',
        options: [['sm', 'Fine'], ['md', 'Medium'], ['lg', 'Heavy']]
      }
    ]
  },
  {
    id: 'steps',
    title: 'Steps from recordings',
    glyph: 'layers',
    blurb: 'The input hook already runs during a take for the keypress HUD. Keeping what it saw means the frame at each click can be pulled out afterwards, turning one recording into a numbered document.',
    rows: [
      {
        kind: 'toggle', key: 'autoSteps', glyph: 'layers', label: 'Track actions while recording',
        sub: 'Stores the clicks and keys of a take alongside the video. Extraction is always a button afterwards — steps are never created without being asked for.'
      },
      {
        kind: 'seg', key: 'autoStepsOn', label: 'What counts as a step',
        options: [['clicks', 'Clicks only'], ['actions', 'Clicks and typing']],
        needs: 'autoSteps'
      },
      {
        kind: 'slider', key: 'autoStepsMax', glyph: 'gauge', label: 'Most steps from one recording',
        sub: 'A long session contains hundreds of clicks, and a document with hundreds of steps is not a document. Over the ceiling, an even spread across the whole take is kept.',
        min: 5, max: 60, step: 5, unit: '',
        needs: 'autoSteps'
      }
    ]
  }
]

export function mountSettings({ root, api }) {
  const sectionNav = el('nav.set-nav')
  const body = el('div.set-body')
  const built = new Map()

  root.append(
    el('div.view-head', {}, [
      el('div.body', {}, [
        el('h1', { text: 'Settings' }),
        el('p', { text: 'Everything the app can be told to do, in one place. Stored as plain JSON in the app’s own folder, so it can be read, diffed and copied between machines.' })
      ]),
      el('div.actions', {}, [
        el('button.btn', { type: 'button', onClick: resetAll }, [icon('refresh'), 'Reset to defaults'])
      ])
    ]),
    el('div.settings', {}, [sectionNav, body])
  )

  /* ─────────────────────────────────────────────────────────── the rows */

  const set = async (patch) => {
    state.settings = await api.settings.write(patch)
    applyTheme()
    paint()
  }

  function toggle(row) {
    const sw = el('button.switch', {
      type: 'button', role: 'switch', 'aria-checked': 'false',
      'aria-label': row.label, dataset: { key: row.key },
      onClick: () => set({ [row.key]: sw.getAttribute('aria-checked') !== 'true' })
    })
    const note = row.unsupported ? el('span.sub', { style: { color: 'var(--warn-text)' } }) : null
    const node = el('div.row', { dataset: { row: row.key } }, [
      icon(row.glyph || 'bolt'),
      el('span.body', {}, [
        el('span.label', { text: row.label }),
        row.sub ? el('span.sub', { text: row.sub }) : null,
        note
      ]),
      sw
    ])
    node.__paint = (settings, info) => {
      sw.setAttribute('aria-checked', String(Boolean(settings[row.key])))
      const blocked = row.unsupported?.(info)
      if (note) { note.textContent = blocked || ''; note.hidden = !blocked }
      const off = row.needs && !settings[row.needs]
      sw.disabled = Boolean(blocked) || off
      node.style.opacity = off ? '.5' : ''
    }
    return node
  }

  function slider(row) {
    const out = el('output')
    const input = el('input', {
      type: 'range', min: String(row.min), max: String(row.max), step: String(row.step),
      'aria-label': row.label
    })
    // Repaint locally while dragging, commit on release: one write per pixel
    // dragged is a disk write per pixel dragged.
    input.addEventListener('input', () => { out.textContent = `${input.value}${row.unit}` })
    input.addEventListener('change', () => set({ [row.key]: Number(input.value) }))

    const node = el('div.row', { dataset: { row: row.key } }, [
      icon(row.glyph || 'gauge'),
      el('span.body', {}, [
        el('span.label', { text: row.label }),
        row.sub ? el('span.sub', { text: row.sub }) : null,
        el('span.slider', { style: { marginTop: '10px' } }, [input, out])
      ])
    ])
    node.__paint = (settings) => {
      const value = Number(settings[row.key])
      input.value = String(value)
      out.textContent = `${value}${row.unit}`
      // Zero is a legitimate choice and reads better as a word than as "0s".
      if (value === 0 && row.unit === 's') out.textContent = 'Off'
    }
    return node
  }

  function segment(row) {
    const buttons = row.options.map(([value, label]) => el('button', {
      type: 'button', dataset: { value }, 'aria-pressed': 'false',
      onClick: () => set({ [row.key]: value })
    }, [label]))
    const seg = el('div.seg', { role: 'group', 'aria-label': row.label }, buttons)
    const node = el('div.row.stacked', { dataset: { row: row.key } }, [
      el('span.body', {}, [
        el('span.label', { text: row.label }),
        row.sub ? el('span.sub', { text: row.sub, style: { marginBottom: '10px' } }) : null,
        seg
      ])
    ])
    node.__paint = (settings) => {
      for (const button of buttons) {
        button.setAttribute('aria-pressed', String(button.dataset.value === settings[row.key]))
      }
      const off = row.needs && !settings[row.needs]
      for (const button of buttons) button.disabled = off
      node.style.opacity = off ? '.5' : ''
    }
    return node
  }

  function swatch(row) {
    const buttons = row.options.map((name) => el('button', {
      type: 'button',
      dataset: row.key === 'accent' ? { accent: name } : { color: name },
      'aria-pressed': 'false',
      title: name[0].toUpperCase() + name.slice(1),
      'aria-label': name,
      onClick: () => set({ [row.key]: name })
    }))
    const wrap = el('div.swatches', { role: 'group', 'aria-label': row.label }, buttons)
    const node = el('div.row.stacked', { dataset: { row: row.key } }, [
      el('span.body', {}, [el('span.label', { text: row.label }), wrap])
    ])
    node.__paint = (settings) => {
      for (const button of buttons) {
        const value = button.dataset.accent || button.dataset.color
        button.setAttribute('aria-pressed', String(value === settings[row.key]))
      }
      const off = row.needs && !settings[row.needs]
      for (const button of buttons) button.disabled = off
      node.style.opacity = off ? '.5' : ''
    }
    return node
  }

  const CORNER_NAMES = {
    tl: 'Top left', tc: 'Top centre', tr: 'Top right',
    bl: 'Bottom left', bc: 'Bottom centre', br: 'Bottom right'
  }

  /**
   * Six buttons drawn as the corner they mean.
   *
   * A dropdown reading "bottom left / bottom centre / bottom right" is a list
   * to parse; a grid of corners is a thing to point at. The choice is spatial,
   * so the control should be too.
   */
  function corner(row) {
    const buttons = Object.keys(CORNER_NAMES).map((code) => el('button', {
      type: 'button', dataset: { corner: code }, 'aria-pressed': 'false',
      title: CORNER_NAMES[code], 'aria-label': CORNER_NAMES[code],
      onClick: () => set({ [row.key]: code })
    }, [el('i')]))

    const grid = el('div.corners', { role: 'group', 'aria-label': row.label }, buttons)
    const node = el('div.row.stacked', { dataset: { row: row.key } }, [
      el('span.body', {}, [
        el('span.label', { text: row.label }),
        row.sub ? el('span.sub', { text: row.sub, style: { marginBottom: '10px' } }) : null,
        grid
      ])
    ])
    node.__paint = (settings) => {
      for (const button of buttons) {
        button.setAttribute('aria-pressed', String(button.dataset.corner === settings[row.key]))
      }
      const off = row.needs && !settings[row.needs]
      for (const button of buttons) button.disabled = off
      node.style.opacity = off ? '.5' : ''
    }
    return node
  }

  const RENDER = { toggle, slider, seg: segment, swatch, corner }

  /* ────────────────────────────────────────────────────── the shortcuts */

  const hotkeyRows = el('div.rows')
  const conflictNote = el('div.note', { hidden: true }, [icon('alert'), el('span')])
  const takenNote = el('div.note', { hidden: true }, [icon('alert'), el('span')])
  let recording = null

  /**
   * A real key press, turned into an Electron accelerator.
   *
   * Asking somebody to type `CommandOrControl+Shift+3` is asking them to know a
   * string format, and they will get it wrong in a way that throws inside
   * `globalShortcut.register` rather than failing politely. Pressing the keys is
   * the only interface that cannot produce an invalid binding.
   *
   * Returns null while only modifiers are held, or the first `Shift` of a chord
   * would be recorded as the whole binding.
   */
  function toAccelerator(event) {
    const parts = []
    if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
    if (event.altKey) parts.push('Alt')
    if (event.shiftKey) parts.push('Shift')

    const key = event.key
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return null

    let name = null
    if (/^[a-z]$/i.test(key)) name = key.toUpperCase()
    else if (/^[0-9]$/.test(key)) name = key
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) name = key
    else {
      // `event.code` for the digit row, so Shift+3 records as `3` rather than
      // as the `#` the layout produced.
      const digit = /^Digit([0-9])$/.exec(event.code)
      name = digit ? digit[1] : {
        ' ': 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
        Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
        PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down',
        ArrowLeft: 'Left', ArrowRight: 'Right', PrintScreen: 'PrintScreen'
      }[key] || null
    }
    if (!name || !parts.length) return null
    return [...parts, name].join('+')
  }

  function paintHotkeys() {
    hotkeyRows.replaceChildren(...Object.entries(ACTIONS).map(([action, label]) => {
      const combo = state.settings.hotkeys[action]
      const chip = el('button.kbd', {
        type: 'button',
        dataset: { action },
        style: { cursor: 'pointer', minWidth: '150px' },
        text: recording === action ? 'Press keys…' : prettyHotkey(combo, state.info?.platform),
        onClick: () => beginRecord(action)
      })
      if (recording === action) chip.style.borderColor = 'var(--accent)'
      return el('div.row', {}, [
        icon('keyboard'),
        el('span.body', {}, [el('span.label', { text: label })]),
        chip
      ])
    }))

    const clashes = conflicts(state.settings.hotkeys)
    conflictNote.hidden = !clashes.length
    if (clashes.length) {
      const [first] = clashes
      conflictNote.lastElementChild.textContent =
        `${prettyHotkey(first.combo, state.info?.platform)} is bound to two actions — ` +
        `${ACTIONS[first.actions[0]]} and ${ACTIONS[first.actions[1]]}. Only the first will fire.`
    }
  }

  function beginRecord(action) {
    recording = action
    paintHotkeys()

    const finish = async (combo) => {
      removeEventListener('keydown', onKey, true)
      recording = null
      if (combo !== undefined) await set({ hotkeys: { ...state.settings.hotkeys, [action]: combo } })
      paintHotkeys()
    }

    const onKey = (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') { finish(); return }
      // An unbound action is a legitimate choice, and this is the only way to
      // say it.
      if (event.key === 'Backspace' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        finish('')
        return
      }
      const combo = toAccelerator(event)
      if (!combo) return
      if (!isAccelerator(combo)) { toast('That combination cannot be bound', { tone: 'warn' }); return }
      finish(combo)
    }
    addEventListener('keydown', onKey, true)
  }

  api.hotkeys.onState(({ failed }) => {
    takenNote.hidden = !failed.length
    if (failed.length) {
      takenNote.lastElementChild.textContent =
        `Already in use by another application: ${failed
          .map((f) => prettyHotkey(f.combo, state.info?.platform)).join(', ')}. Pick different keys.`
    }
  })

  /* ──────────────────────────────────────────────────── library & about */

  const libPath = el('span.mono', {
    style: { fontFamily: 'var(--mono)', fontSize: '10.5px', wordBreak: 'break-all', color: 'var(--faint)', display: 'block', marginTop: '4px' }
  })
  const libSize = el('span.trail')
  const about = el('div.rows')

  async function paintLibrary() {
    const stats = await api.library.stats()
    libPath.textContent = stats.path
    libSize.textContent = humanBytes(stats.bytes)
  }

  /**
   * The version and who made it, and nothing else.
   *
   * The Electron and Chromium versions were here because they were easy to
   * print, not because anybody needs them — a user reading this wants to know
   * what they are running and who to talk to about it. The runtime versions are
   * a support question, and they are already in the About row of a crash report
   * and in `package.json`.
   */
  function paintAbout() {
    const info = state.info || {}
    const line = (label, value) => el('div.row', {}, [
      el('span.body', {}, [el('span.label', { text: label })]),
      el('span.trail', { text: value })
    ])
    about.replaceChildren(
      line('Version', `v${info.version || '—'}`),
      line('From', 'Delog Pvt Ltd')
    )
  }

  async function prune() {
    const removed = await api.library.prune()
    toast(removed ? `Removed ${removed} empty session${removed === 1 ? '' : 's'}` : 'Nothing to clear')
    await paintLibrary()
  }

  async function resetAll() {
    state.settings = await api.settings.reset()
    applyTheme()
    paint()
    toast('Settings reset to defaults')
  }

  /* ──────────────────────────────────────────────────────────── assembly */

  const EXTRA = [
    {
      id: 'shortcuts',
      title: 'Shortcuts',
      glyph: 'keyboard',
      blurb: 'These work anywhere on the machine, including with this window closed. Click one and press the keys you want — Escape cancels, Backspace unbinds.',
      node: () => el('div', {}, [hotkeyRows, el('div', { style: { height: '10px' } }), conflictNote, takenNote])
    },
    {
      id: 'library',
      title: 'Library',
      glyph: 'folder',
      blurb: 'One folder per session, with the images and recordings beside a readable index. Move it, copy it, or open it in a file manager — nothing here depends on a database.',
      node: () => el('div', {}, [
        el('div.rows', {}, [
          el('div.row', {}, [
            icon('folder'),
            el('span.body', {}, [el('span.label', { text: 'On disk' }), libPath]),
            libSize
          ])
        ]),
        el('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } }, [
          el('button.btn', { type: 'button', onClick: () => api.library.reveal(null) }, [icon('folder'), 'Open folder']),
          el('button.btn', { type: 'button', onClick: prune }, [icon('trash'), 'Clear empty sessions'])
        ])
      ])
    },
    {
      id: 'about',
      title: 'About',
      glyph: 'shield',
      blurb: 'Rebind Capture is part of the Rebind suite.',
      node: () => about
    }
  ]

  const ALL = [...SECTIONS, ...EXTRA]

  for (const section of ALL) {
    const rows = section.rows
      ? el('div.rows', {}, section.rows.map((row) => {
        const node = RENDER[row.kind](row)
        built.set(`${section.id}:${row.key}`, node)
        return node
      }))
      : section.node()

    body.append(el('section.card.set-card', { id: `set-${section.id}` }, [
      el('h2', {}, [icon(section.glyph), section.title]),
      section.blurb ? el('p.sub', { text: section.blurb }) : null,
      rows
    ]))
  }

  sectionNav.replaceChildren(...ALL.map((section) => el('button.set-link', {
    type: 'button',
    dataset: { section: section.id },
    onClick: () => {
      root.querySelector(`#set-${section.id}`)
        .scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [icon(section.glyph), section.title])))

  /**
   * Highlight whichever section is under the top of the viewport.
   *
   * An observer rather than a scroll handler, so it costs nothing while the
   * page is still. The margin biases the intersection to the top third —
   * without it the "current" section flips to the next one the moment its first
   * pixel appears, which is not what the eye is reading.
   */
  const spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const id = entry.target.id.replace('set-', '')
      for (const link of sectionNav.children) {
        link.setAttribute('aria-current', String(link.dataset.section === id))
      }
    }
  }, { root: root, rootMargin: '0px 0px -66% 0px', threshold: 0 })

  for (const section of ALL) spy.observe(root.querySelector(`#set-${section.id}`))

  function paint() {
    const settings = state.settings
    for (const node of built.values()) node.__paint?.(settings, state.info)
    paintHotkeys()
    paintAbout()
  }

  return {
    async enter() {
      paint()
      await paintLibrary()
    }
  }
}
