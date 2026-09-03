/**
 * The count-in's whole behaviour.
 *
 * Main drives the number; this only draws it. There is deliberately no timer
 * here — the seconds that matter are the ones the recorder is actually waiting
 * for, and a second clock in a second window would drift away from them and
 * show "1" while the take had already started.
 */

const api = window.capture
const ring = document.getElementById('ring')
let node = document.getElementById('n')

api.count.onTick(({ n }) => {
  // Replaced rather than relabelled, so the pop animation restarts on each
  // tick. Setting `textContent` alone leaves the number sitting there.
  const next = document.createElement('div')
  next.id = 'n'
  next.textContent = String(n)
  node.replaceWith(next)
  node = next
  ring.dataset.n = String(n)
})
