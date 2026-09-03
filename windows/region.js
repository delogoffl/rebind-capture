/**
 * Dragging out a rectangle.
 *
 * One of these runs per display. Whichever one the drag happens on answers with
 * its own display id and a rectangle in that display's CSS pixels; main scales
 * it to the captured image and crops. The others simply close.
 *
 * Coordinates are the window's own — each overlay is positioned at its
 * display's origin and sized to it, so `clientX` is already display-relative
 * and no arithmetic about virtual-desktop offsets is needed anywhere. That is
 * the whole reason for one window per display rather than one spanning them
 * all: the multi-monitor coordinate maths that a single window would need is
 * where this kind of feature usually goes wrong, especially with mixed scale
 * factors.
 */

const api = window.capture
const veil = document.getElementById('veil')
const box = document.getElementById('box')
const size = document.getElementById('size')
const hint = document.getElementById('hint')

const displayId = Number(new URLSearchParams(location.search).get('display'))

let from = null
let rect = null
let done = false

const MIN = 4

function paint(a, b) {
  rect = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
  veil.classList.add('gone')
  box.classList.add('on')
  box.style.left = `${rect.x}px`
  box.style.top = `${rect.y}px`
  box.style.width = `${rect.width}px`
  box.style.height = `${rect.height}px`
  size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
  // A label above a selection that starts near the top would be off screen.
  size.classList.toggle('inside', rect.y < 34)
}

function finish() {
  if (done) return
  done = true
  if (!rect || rect.width < MIN || rect.height < MIN) {
    api.region.cancel()
    return
  }
  api.region.done({ displayId, rect })
}

addEventListener('pointerdown', (event) => {
  if (event.button !== 0) { api.region.cancel(); return }
  from = { x: event.clientX, y: event.clientY }
  hint.classList.add('away')
  // Capture on the document, so a drag that leaves this window — onto another
  // monitor, or past the edge — still ends here rather than being lost.
  document.documentElement.setPointerCapture(event.pointerId)
})

addEventListener('pointermove', (event) => {
  if (!from) return
  paint(from, { x: event.clientX, y: event.clientY })
})

addEventListener('pointerup', () => { if (from) finish() })
addEventListener('pointercancel', () => { if (from) { from = null; api.region.cancel() } })

addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    done = true
    api.region.cancel()
  }
})

// A right-click or a context menu is a cancel too: the overlay covers the whole
// screen, and being unable to get rid of it is the worst thing it could do.
addEventListener('contextmenu', (event) => {
  event.preventDefault()
  done = true
  api.region.cancel()
})

// The overlay steals the pointer from every other window; if it somehow loses
// focus without a selection, it has no reason to still be there.
addEventListener('blur', () => { if (!from && !done) api.region.cancel() })

// Focus the document so the keydown listener actually receives Escape — a
// transparent frameless window does not always get keyboard focus on show.
addEventListener('DOMContentLoaded', () => window.focus())
window.focus()
