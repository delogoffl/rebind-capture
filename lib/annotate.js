/**
 * Marks on a capture.
 *
 * `annotations` has been in the step model, revived from disk and counted in
 * every report since the first build, and until now nothing could create one —
 * so the "redactions: 0" line in an export was not a fact, it was the only
 * value it could ever have.
 *
 * Two decisions shape everything here.
 *
 * The first is that marks are **burnt into the pixels**. The app already works
 * this way for the cursor ring and the keypress caps, for the reason written at
 * `renderer/app.js`: a marker that only exists in this app's viewer is not
 * evidence, because the PNG is what gets attached to the ticket. An annotation
 * layer that renders only in Rebind Capture would be a worse version of the
 * same mistake. `annotations` therefore records *what was done to the image*
 * for the report to count — it is provenance, not an editable overlay.
 *
 * The second is that **redaction is destructive**. Every other mark keeps a
 * pristine copy beside it so it can be undone; a redaction deletes that copy.
 * Blur-as-a-layer has leaked real data in real incidents — the underlying
 * pixels were still in the file, and a layer is only as hidden as the reader is
 * incurious. If this tool says a region is gone, the bytes are gone.
 *
 * Coordinates are image pixels, matching `step.cursor`, so a mark means the
 * same thing regardless of the size the editor happened to display the image
 * at.
 */

/** Every kind of mark, and whether it destroys what is underneath. */
export const TYPES = Object.freeze({
  box: { label: 'Box', destructive: false, fills: false },
  arrow: { label: 'Arrow', destructive: false, fills: false },
  highlight: { label: 'Highlight', destructive: false, fills: true },
  step: { label: 'Number', destructive: false, fills: true },
  redact: { label: 'Redact', destructive: true, fills: true }
})

export const TYPE_NAMES = Object.freeze(Object.keys(TYPES))

/**
 * The palette, which is deliberately small.
 *
 * These are marks on evidence, not drawings. A colour picker invites matching
 * the screenshot's own palette, which is the one thing an annotation must never
 * do — it has to be the thing that is obviously not part of the picture.
 */
export const COLORS = Object.freeze({
  red: '#F43F5E',
  amber: '#F59E0B',
  green: '#10B981',
  cyan: '#06B6D4',
  indigo: '#6366F1'
})

export const DEFAULT_COLOR = 'red'

/** Stroke width in image pixels, scaled by how big the image is. */
export const WEIGHTS = Object.freeze({ sm: 2, md: 4, lg: 7 })

export const MIN_SIZE = 6

let counter = 0
const makeId = () => `a-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 5)}`

/**
 * Turn a dragged rectangle into a stored annotation.
 *
 * The rectangle is normalised first, because dragging up and to the left is an
 * ordinary way to draw a box and produces negative width — every consumer
 * downstream would otherwise need to know that.
 */
export function makeAnnotation(type, rect, { color = DEFAULT_COLOR, weight = 'md', number, at = Date.now() } = {}) {
  if (!TYPES[type]) throw new Error(`Unknown annotation type: ${type}`)
  const box = normaliseRect(rect)
  return {
    id: makeId(),
    type,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    color: COLORS[color] ? color : DEFAULT_COLOR,
    weight: WEIGHTS[weight] ? weight : 'md',
    // Arrows are drawn corner to corner, so which corner the drag started at is
    // the difference between pointing at the button and pointing away from it.
    ...(type === 'arrow' ? { fromX: rect.x, fromY: rect.y, toX: rect.x + rect.width, toY: rect.y + rect.height } : null),
    ...(type === 'step' ? { number: Number(number) || 1 } : null),
    at
  }
}

/** Negative width or height folded into a positive rectangle. */
export function normaliseRect({ x = 0, y = 0, width = 0, height = 0 } = {}) {
  return {
    x: width < 0 ? x + width : x,
    y: height < 0 ? y + height : y,
    width: Math.abs(width),
    height: Math.abs(height)
  }
}

/**
 * Keep a mark inside the picture.
 *
 * A box dragged off the edge is not an error worth refusing — the user meant
 * "to the edge" — so it is clipped rather than rejected. A mark that ends up
 * with no area left is dropped by the caller via `isUsable`.
 */
export function clampToImage(annotation, imageWidth, imageHeight) {
  const x = Math.max(0, Math.min(annotation.x, imageWidth))
  const y = Math.max(0, Math.min(annotation.y, imageHeight))
  const width = Math.max(0, Math.min(annotation.width, imageWidth - x))
  const height = Math.max(0, Math.min(annotation.height, imageHeight - y))

  const out = { ...annotation, x, y, width, height }
  if (annotation.type === 'arrow') {
    out.fromX = Math.max(0, Math.min(annotation.fromX ?? x, imageWidth))
    out.fromY = Math.max(0, Math.min(annotation.fromY ?? y, imageHeight))
    out.toX = Math.max(0, Math.min(annotation.toX ?? x + width, imageWidth))
    out.toY = Math.max(0, Math.min(annotation.toY ?? y + height, imageHeight))
  }
  return out
}

/**
 * Is this worth keeping?
 *
 * A click with no drag produces a zero-area rectangle, and storing those means
 * a report that counts three redactions where the user made one and mis-clicked
 * twice. An arrow is judged on its length instead, since a long thin arrow is
 * perfectly valid and has almost no bounding area.
 */
export function isUsable(annotation) {
  if (!annotation || !TYPES[annotation.type]) return false
  if (annotation.type === 'arrow') {
    const dx = (annotation.toX ?? 0) - (annotation.fromX ?? 0)
    const dy = (annotation.toY ?? 0) - (annotation.fromY ?? 0)
    return Math.hypot(dx, dy) >= MIN_SIZE
  }
  if (annotation.type === 'step') return annotation.width >= MIN_SIZE
  return annotation.width >= MIN_SIZE && annotation.height >= MIN_SIZE
}

/** Topmost mark under a point, so the most recently drawn one wins a click. */
export function hitTest(annotations, { x, y }, slack = 0) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i]
    if (x >= a.x - slack && x <= a.x + a.width + slack &&
        y >= a.y - slack && y <= a.y + a.height + slack) return a
  }
  return null
}

export function moveBy(annotation, dx, dy) {
  const out = { ...annotation, x: annotation.x + dx, y: annotation.y + dy }
  if (annotation.type === 'arrow') {
    out.fromX = (annotation.fromX ?? 0) + dx
    out.fromY = (annotation.fromY ?? 0) + dy
    out.toX = (annotation.toX ?? 0) + dx
    out.toY = (annotation.toY ?? 0) + dy
  }
  return out
}

/**
 * Does anything here remove pixels?
 *
 * This is the question the editor asks before saving, because the answer
 * decides whether the untouched original is kept or deleted, and that decision
 * cannot be revisited afterwards.
 */
export const hasRedaction = (annotations = []) => annotations.some((a) => a?.type === 'redact')

export const countRedactions = (annotations = []) =>
  annotations.filter((a) => a?.type === 'redact').length

/** Renumber `step` marks in the order they were placed, so 1, 2, 3 read as 1, 2, 3. */
export function renumberSteps(annotations = []) {
  let n = 0
  return annotations.map((a) => (a.type === 'step' ? { ...a, number: ++n } : a))
}

/**
 * A count per type, for the report and the editor's status line.
 *
 * Returned as a plain object with every type present, so a caller can read
 * `counts.redact` without checking for undefined first.
 */
export function countByType(annotations = []) {
  const counts = Object.fromEntries(TYPE_NAMES.map((name) => [name, 0]))
  for (const a of annotations) {
    if (counts[a?.type] !== undefined) counts[a.type]++
  }
  return counts
}

/** "2 boxes · 1 redaction", for the tile caption and the toast. */
export function describe(annotations = []) {
  const counts = countByType(annotations)
  const parts = []
  const plural = { box: 'boxes', arrow: 'arrows', highlight: 'highlights', step: 'numbers', redact: 'redactions' }
  const single = { box: 'box', arrow: 'arrow', highlight: 'highlight', step: 'number', redact: 'redaction' }
  for (const name of TYPE_NAMES) {
    if (counts[name]) parts.push(`${counts[name]} ${counts[name] === 1 ? single[name] : plural[name]}`)
  }
  return parts.join(' · ')
}

/**
 * What the model stores, stripped of anything the editor invented.
 *
 * The step model goes to disk and into a manifest, so the shape has to be
 * stable and free of live editor state — a `selected` flag that survived into
 * `session.json` would end up in an exported evidence pack.
 */
export function serialise(annotation) {
  const out = {
    id: annotation.id,
    type: annotation.type,
    x: Math.round(annotation.x),
    y: Math.round(annotation.y),
    width: Math.round(annotation.width),
    height: Math.round(annotation.height),
    color: annotation.color,
    weight: annotation.weight,
    at: annotation.at || Date.now()
  }
  if (annotation.type === 'arrow') {
    out.fromX = Math.round(annotation.fromX ?? out.x)
    out.fromY = Math.round(annotation.fromY ?? out.y)
    out.toX = Math.round(annotation.toX ?? out.x + out.width)
    out.toY = Math.round(annotation.toY ?? out.y + out.height)
  }
  if (annotation.type === 'step') out.number = Number(annotation.number) || 1
  return out
}

/** Whatever came off disk, coerced into something safe to draw. */
export function reviveAnnotation(raw) {
  if (!raw || !TYPES[raw.type]) return null
  const box = normaliseRect({
    x: Number(raw.x) || 0,
    y: Number(raw.y) || 0,
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0
  })
  return {
    id: String(raw.id || makeId()),
    type: raw.type,
    ...box,
    color: COLORS[raw.color] ? raw.color : DEFAULT_COLOR,
    weight: WEIGHTS[raw.weight] ? raw.weight : 'md',
    ...(raw.type === 'arrow'
      ? {
          fromX: Number(raw.fromX) || box.x,
          fromY: Number(raw.fromY) || box.y,
          toX: Number(raw.toX) || box.x + box.width,
          toY: Number(raw.toY) || box.y + box.height
        }
      : null),
    ...(raw.type === 'step' ? { number: Number(raw.number) || 1 } : null),
    at: Number(raw.at) || 0
  }
}

/**
 * How thick to draw, given how big the image is.
 *
 * A 2px box on a 4K screenshot is invisible once the image is scaled to fit a
 * PDF page; the same 2px on a 400px region capture is a slab. So the weight is
 * a fraction of the image's smaller side, floored so it never disappears.
 */
export function strokeWidth(weight, imageWidth, imageHeight) {
  const base = WEIGHTS[weight] || WEIGHTS.md
  const scale = Math.max(1, Math.min(imageWidth, imageHeight) / 720)
  return Math.max(2, Math.round(base * scale))
}
