/**
 * Marking up a capture.
 *
 * Opened from a step in the library, resolves to the annotations that were
 * made, or null if the user cancelled. It does not save anything itself — the
 * library owns the session and the files, and an editor that wrote to disk
 * behind its caller's back would be the second thing in this app that could
 * modify a step.
 *
 * The important behaviour is at the end, in what the caller then does with the
 * result, and it is worth stating here because this is the screen where the
 * user makes the decision: a redaction destroys the original. Every other mark
 * keeps an untouched copy beside the file so it can be taken back off. The
 * dialog says so, once, at the moment it becomes true rather than in a
 * preference nobody read.
 */

import { el, icon, confirm } from './ui.js'
import {
  TYPES, TYPE_NAMES, COLORS, makeAnnotation, clampToImage, isUsable,
  hitTest, moveBy, hasRedaction, describe as describeMarks, renumberSteps, serialise
} from '../lib/annotate.js'
import { drawAnnotations, drawSuggestions } from './annotate-draw.js'

const GLYPH = { box: 'crop', arrow: 'cursor', highlight: 'pen', step: 'record', redact: 'eye' }

/**
 * @param {object} options
 * @param {ImageBitmap|HTMLImageElement} options.image  the capture, full size
 * @param {Array} [options.annotations]  marks already on it
 * @param {Array} [options.suggestions]  candidate boxes from `lib/diff.js`
 * @returns {Promise<Array|null>}  the marks to burn in, or null for cancel
 */
export function openEditor({
  image,
  annotations = [],
  suggestions = [],
  title = 'Annotate',
  settings = {},
  onDone
} = {}) {
  return new Promise((resolve) => {
    const width = image.width
    const height = image.height

    let marks = annotations.map((a) => ({ ...a }))
    let tool = 'box'
    let color = COLORS[settings.annotateColor] ? settings.annotateColor : 'red'
    let weight = settings.annotateWeight || 'md'
    let drawing = null
    let selected = null
    let hoverSuggestion = -1
    const undo = []

    /* ─────────────────────────────────────────────────────────── the canvas */

    const canvas = el('canvas.edit-canvas')
    const stage = el('div.edit-stage', {}, [canvas])

    /** Display scale: the image is shown to fit, marks are stored full size. */
    let scale = 1

    function fit() {
      const box = stage.getBoundingClientRect()
      if (!box.width || !box.height) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      scale = Math.min(box.width / width, box.height / height, 1)
      canvas.style.width = `${Math.round(width * scale)}px`
      canvas.style.height = `${Math.round(height * scale)}px`
      canvas.width = Math.round(width * scale * dpr)
      canvas.height = Math.round(height * scale * dpr)
      paint()
    }

    function paint() {
      const ctx = canvas.getContext('2d')
      const dpr = canvas.width / Math.max(1, Math.round(width * scale))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width * scale, height * scale)
      ctx.drawImage(image, 0, 0, width * scale, height * scale)

      const live = drawing && isUsable(drawing) ? [...marks, drawing] : marks
      drawAnnotations(ctx, live, { width, height, scale })

      if (suggestions.length && settings.autoHighlight !== false) {
        drawSuggestions(ctx, suggestions, { scale, active: hoverSuggestion })
      }
      if (selected) outline(ctx, selected)
      paintStatus()
    }

    /** A selection ring, drawn on the overlay only — never into the image. */
    function outline(ctx, mark) {
      ctx.save()
      ctx.setLineDash([5, 4])
      ctx.lineWidth = 1.5
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.strokeRect(mark.x * scale - 3, mark.y * scale - 3, mark.width * scale + 6, mark.height * scale + 6)
      ctx.restore()
    }

    /* ──────────────────────────────────────────────────────────── pointing */

    const at = (event) => {
      const box = canvas.getBoundingClientRect()
      return {
        x: (event.clientX - box.left) / scale,
        y: (event.clientY - box.top) / scale
      }
    }

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      canvas.setPointerCapture(event.pointerId)
      const point = at(event)

      // A click on a suggestion accepts it, which is the whole point of
      // suggesting: one click to box the thing that changed.
      const which = suggestions.findIndex((r) =>
        point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height)
      if (which >= 0 && !marks.some((m) => m.suggested === which)) {
        push(makeAnnotation(tool === 'redact' ? 'redact' : 'box', suggestions[which], { color, weight }))
        marks[marks.length - 1].suggested = which
        paint()
        return
      }

      const hit = hitTest(marks, point, 4)
      if (hit && !event.shiftKey) {
        selected = hit
        drawing = null
        dragging = { mark: hit, from: point }
        paint()
        return
      }

      selected = null
      drawing = makeAnnotation(tool, { x: point.x, y: point.y, width: 0, height: 0 }, { color, weight })
      drawing.origin = point
    })

    let dragging = null

    canvas.addEventListener('pointermove', (event) => {
      const point = at(event)

      if (dragging) {
        const moved = moveBy(dragging.mark, point.x - dragging.from.x, point.y - dragging.from.y)
        Object.assign(dragging.mark, clampToImage(moved, width, height))
        dragging.from = point
        selected = dragging.mark
        paint()
        return
      }

      if (drawing) {
        const origin = drawing.origin
        const next = makeAnnotation(tool, {
          x: origin.x, y: origin.y, width: point.x - origin.x, height: point.y - origin.y
        }, { color, weight, number: nextNumber() })
        next.origin = origin
        drawing = clampToImage(next, width, height)
        drawing.origin = origin
        paint()
        return
      }

      const over = suggestions.findIndex((r) =>
        point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height)
      if (over !== hoverSuggestion) { hoverSuggestion = over; paint() }
      canvas.style.cursor = hitTest(marks, point, 4) ? 'move' : over >= 0 ? 'pointer' : 'crosshair'
    })

    const finishDrag = () => {
      if (dragging) { dragging = null; return }
      if (!drawing) return
      const made = drawing
      drawing = null
      delete made.origin
      // A click with no drag is a mis-click, not a zero-sized annotation; the
      // alternative is a report that counts three redactions where one was made.
      if (isUsable(made)) { push(made); selected = made }
      paint()
    }

    canvas.addEventListener('pointerup', finishDrag)
    canvas.addEventListener('pointercancel', finishDrag)
    canvas.addEventListener('pointerleave', () => {
      if (hoverSuggestion !== -1) { hoverSuggestion = -1; paint() }
    })

    const nextNumber = () => marks.filter((m) => m.type === 'step').length + 1

    function push(mark) {
      undo.push(marks.map((m) => ({ ...m })))
      marks.push(mark)
      marks = renumberSteps(marks)
    }

    function stepBack() {
      if (!undo.length) return
      marks = undo.pop()
      selected = null
      paint()
    }

    function removeSelected() {
      if (!selected) return
      undo.push(marks.map((m) => ({ ...m })))
      marks = renumberSteps(marks.filter((m) => m !== selected))
      selected = null
      paint()
    }

    /* ────────────────────────────────────────────────────────────── chrome */

    const toolButtons = TYPE_NAMES.map((name) =>
      el('button.tool', {
        type: 'button',
        dataset: { tool: name },
        'aria-pressed': String(name === tool),
        title: TYPES[name].label,
        'aria-label': TYPES[name].label,
        onClick: () => { tool = name; selected = null; paintChrome(); paint() }
      }, [icon(GLYPH[name] || 'pen'), el('span', { text: TYPES[name].label })]))

    const colorButtons = Object.keys(COLORS).map((name) =>
      el('button.swatch', {
        type: 'button',
        dataset: { color: name },
        'aria-pressed': String(name === color),
        title: name,
        'aria-label': `Colour: ${name}`,
        style: { '--swatch': COLORS[name] },
        onClick: () => { color = name; paintChrome() }
      }))

    const weightButtons = ['sm', 'md', 'lg'].map((name) =>
      el('button.weight', {
        type: 'button',
        dataset: { weight: name },
        'aria-pressed': String(name === weight),
        title: `${name} stroke`,
        'aria-label': `Stroke: ${name}`,
        onClick: () => { weight = name; paintChrome() }
      }, [el('i')]))

    const status = el('span.edit-status')
    const warn = el('div.edit-warn', { hidden: true }, [
      icon('alert'),
      el('span', {
        text: 'Redaction is permanent. The pixels underneath are replaced and the untouched copy is deleted — this step cannot be restored afterwards.'
      })
    ])

    function paintStatus() {
      const summary = describeMarks(marks)
      status.textContent = summary || 'Drag on the image to mark it up'
      warn.hidden = !hasRedaction(marks)
    }

    function paintChrome() {
      for (const node of toolButtons) node.setAttribute('aria-pressed', String(node.dataset.tool === tool))
      for (const node of colorButtons) node.setAttribute('aria-pressed', String(node.dataset.color === color))
      for (const node of weightButtons) node.setAttribute('aria-pressed', String(node.dataset.weight === weight))
    }

    const done = (value) => {
      removeEventListener('keydown', onKey, true)
      observer.disconnect()
      scrim.classList.add('leaving')
      scrim.addEventListener('animationend', () => scrim.remove(), { once: true })
      setTimeout(() => scrim.remove(), 400)
      resolve(value)
    }

    async function save() {
      const keep = marks.filter(isUsable).map(serialise)
      if (hasRedaction(keep)) {
        const ok = await confirm({
          title: 'Redact permanently?',
          body: `This replaces the pixels under ${keep.filter((m) => m.type === 'redact').length === 1 ? 'the redaction' : 'each redaction'} and deletes the untouched copy of this capture. It cannot be undone, and that is the point — a redaction you can peel off is not a redaction.`,
          action: 'Redact and save',
          tone: 'bad',
          glyph: 'eye'
        })
        if (!ok) return
      }
      done(keep)
      onDone?.(keep)
    }

    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); done(null); return }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selected) { event.preventDefault(); removeSelected() }
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); stepBack(); return
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault(); save(); return
      }
      // Number keys pick a tool, the way every drawing program does.
      const index = Number(event.key) - 1
      if (Number.isInteger(index) && TYPE_NAMES[index] && !event.ctrlKey && !event.metaKey) {
        tool = TYPE_NAMES[index]; paintChrome(); paint()
      }
    }

    const card = el('div.editor', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('div.edit-bar', {}, [
        el('div.edit-tools', {}, toolButtons),
        el('div.edit-style', {}, [
          el('div.swatches', {}, colorButtons),
          el('div.weights', {}, weightButtons)
        ]),
        el('div.edit-acts', {}, [
          el('button.btn', {
            type: 'button', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo',
            onClick: stepBack
          }, [icon('refresh')]),
          el('button.btn', { type: 'button', onClick: () => done(null) }, ['Cancel']),
          el('button.btn.confirm-go.go', { type: 'button', onClick: save }, ['Save'])
        ])
      ]),
      stage,
      el('div.edit-foot', {}, [status, warn])
    ])

    const scrim = el('div.scrim.wide', {
      onMousedown: (event) => { if (event.target === scrim) done(null) }
    }, [card])

    addEventListener('keydown', onKey, true)
    document.body.append(scrim)

    // The stage is sized by CSS, so the canvas can only be sized once it has a
    // box — and it has to be resized whenever the window is.
    const observer = new ResizeObserver(() => fit())
    observer.observe(stage)
    requestAnimationFrame(fit)
    paintChrome()
  })
}

/**
 * Burn marks into an image and hand back PNG bytes.
 *
 * This is the step that makes an annotation real. The canvas is the full size
 * of the original — never the size it was displayed at — because re-encoding
 * from the preview would quietly downsample every annotated capture in the
 * library, and nobody would notice until an exported PDF looked soft.
 */
export async function burnAnnotations(bytes, annotations, { type = 'image/png' } = {}) {
  const blob = new Blob([bytes], { type })
  const image = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    drawAnnotations(ctx, annotations, { width: image.width, height: image.height, scale: 1 })

    const out = await new Promise((resolve) => canvas.toBlob(resolve, type))
    return new Uint8Array(await out.arrayBuffer())
  } finally {
    image.close?.()
  }
}
