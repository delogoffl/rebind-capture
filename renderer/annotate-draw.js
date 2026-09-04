/**
 * Drawing marks onto a canvas.
 *
 * One implementation, used twice: the editor draws onto a preview at whatever
 * size the image is displayed, and the save path draws onto a full-size canvas
 * that is then re-encoded as the PNG. Sharing it is the point — an editor that
 * previews a redaction one way and burns it in another is an editor that lies
 * about what it did, and this is the module where that lie would live.
 *
 * Everything takes coordinates in *image* pixels and a `scale` for the display,
 * so the same annotation renders identically on a 320px preview and a 4K
 * original except for resolution.
 */

import { COLORS, strokeWidth, TYPES } from '../lib/annotate.js'

/**
 * Paint every mark, in order.
 *
 * Redactions go last regardless of the order they were drawn in. A box drawn
 * on top of a redaction is a decoration; a box *underneath* one that was
 * painted over is nothing at all — and the one thing that must never happen is
 * an annotation drawn over a redaction leaving a gap in it.
 */
export function drawAnnotations(ctx, annotations, { width, height, scale = 1 } = {}) {
  const ordered = [
    ...annotations.filter((a) => a.type !== 'redact'),
    ...annotations.filter((a) => a.type === 'redact')
  ]
  for (const mark of ordered) draw(ctx, mark, { width, height, scale })
}

export function draw(ctx, mark, { width, height, scale = 1 } = {}) {
  if (!TYPES[mark?.type]) return
  const color = COLORS[mark.color] || COLORS.red
  const line = Math.max(1, strokeWidth(mark.weight, width, height) * scale)

  const x = mark.x * scale
  const y = mark.y * scale
  const w = mark.width * scale
  const h = mark.height * scale

  ctx.save()
  switch (mark.type) {
    case 'redact': redact(ctx, x, y, w, h); break
    case 'highlight': highlight(ctx, x, y, w, h, color); break
    case 'box': box(ctx, x, y, w, h, color, line); break
    case 'arrow': arrow(ctx, mark, color, line, scale); break
    case 'step': number(ctx, x, y, w, h, color, line, mark.number ?? 1); break
  }
  ctx.restore()
}

/**
 * A redaction is opaque, flat, and obviously deliberate.
 *
 * Not a blur, not a pixelation, not a translucent panel. Blur and pixelation
 * are reversible in principle and have been reversed in practice; a translucent
 * black leaves the text underneath legible at the wrong gamma. Solid fill is
 * the only one of these whose appearance matches what actually happened to the
 * bytes underneath it.
 *
 * The hatched border is so a redaction reads as a redaction and not as a UI
 * element that happened to be black — a reviewer should never have to wonder
 * whether a black rectangle was in the original screen.
 */
function redact(ctx, x, y, w, h) {
  ctx.fillStyle = '#000000'
  ctx.globalAlpha = 1
  ctx.fillRect(x, y, w, h)

  const step = Math.max(6, Math.min(w, h) / 6)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = Math.max(1, step / 6)
  ctx.beginPath()
  for (let i = -h; i < w; i += step) {
    ctx.moveTo(x + i, y + h)
    ctx.lineTo(x + i + h, y)
  }
  ctx.stroke()
  ctx.restore()
}

function highlight(ctx, x, y, w, h, color) {
  // Multiply, so the text underneath stays readable through it — a highlighter
  // that hides what it highlights is a redaction with a friendlier name.
  ctx.globalCompositeOperation = 'multiply'
  ctx.fillStyle = color
  ctx.globalAlpha = 0.32
  ctx.fillRect(x, y, w, h)
}

function box(ctx, x, y, w, h, color, line) {
  // A dark halo under the stroke, so a red box is visible on a red background.
  // Without it the mark disappears exactly where somebody drew it to point at
  // something that was already the wrong colour.
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'
  ctx.lineWidth = line + Math.max(2, line * 0.6)
  ctx.lineJoin = 'round'
  roundRect(ctx, x, y, w, h, line)
  ctx.stroke()

  ctx.strokeStyle = color
  ctx.lineWidth = line
  roundRect(ctx, x, y, w, h, line)
  ctx.stroke()
}

function arrow(ctx, mark, color, line, scale) {
  const x1 = (mark.fromX ?? mark.x) * scale
  const y1 = (mark.fromY ?? mark.y) * scale
  const x2 = (mark.toX ?? mark.x + mark.width) * scale
  const y2 = (mark.toY ?? mark.y + mark.height) * scale

  const angle = Math.atan2(y2 - y1, x2 - x1)
  const head = Math.max(line * 3.2, 10)

  const shaft = () => {
    ctx.beginPath()
    // Stop the shaft short of the point, or it pokes through the head.
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2 - Math.cos(angle) * head * 0.7, y2 - Math.sin(angle) * head * 0.7)
    ctx.stroke()
  }
  const point = () => {
    ctx.beginPath()
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - Math.cos(angle - 0.42) * head, y2 - Math.sin(angle - 0.42) * head)
    ctx.lineTo(x2 - Math.cos(angle + 0.42) * head, y2 - Math.sin(angle + 0.42) * head)
    ctx.closePath()
    ctx.fill()
  }

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.lineWidth = line + Math.max(2, line * 0.6)
  shaft(); point()

  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = line
  shaft(); point()
}

/**
 * A numbered disc, for "do this first, then this".
 *
 * Sized from the mark rather than fixed, so one drawn on a 4K capture is not a
 * dot. The digit is drawn with the canvas's own text metrics rather than a
 * guessed offset, because a number sitting slightly low in its circle is the
 * kind of thing that makes an exported document look homemade.
 */
function number(ctx, x, y, w, h, color, line, value) {
  const size = Math.max(w, h, line * 6)
  const cx = x + size / 2
  const cy = y + size / 2
  const r = size / 2

  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = Math.max(1, line * 0.5)
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'
  ctx.stroke()

  ctx.fillStyle = '#FFFFFF'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 ${Math.round(r * 1.25)}px system-ui, -apple-system, Segoe UI, sans-serif`
  ctx.fillText(String(value), cx, cy)
}

function roundRect(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * The candidate boxes `lib/diff.js` suggested.
 *
 * Dashed and unfilled, so there is never a moment where a suggestion could be
 * mistaken for a mark that was actually made. Nothing here reaches the saved
 * image — these are drawn on the editor's overlay only.
 */
export function drawSuggestions(ctx, regions, { scale = 1, active = -1 } = {}) {
  ctx.save()
  ctx.lineJoin = 'round'
  regions.forEach((region, i) => {
    const on = i === active
    ctx.setLineDash(on ? [] : [7, 5])
    ctx.lineWidth = on ? 3 : 2
    ctx.strokeStyle = on ? 'rgba(99,102,241,0.95)' : 'rgba(99,102,241,0.65)'
    ctx.fillStyle = 'rgba(99,102,241,0.10)'
    const x = region.x * scale
    const y = region.y * scale
    const w = region.width * scale
    const h = region.height * scale
    ctx.fillRect(x, y, w, h)
    ctx.strokeRect(x, y, w, h)
  })
  ctx.restore()
}
