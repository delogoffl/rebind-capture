/**
 * What changed between two captures.
 *
 * Consecutive steps in a session are almost always the same screen a moment
 * apart, which makes the interesting part — the menu that opened, the field
 * that filled, the row that appeared — computable rather than something the
 * author has to point at by hand. Placing the box is the part of writing
 * documentation people actually skip, so doing it for them is worth more than
 * another drawing tool.
 *
 * Two things keep this honest.
 *
 * It works on a **block grid**, not on pixels. Comparing 4K images pixel by
 * pixel in JavaScript is slow enough to feel broken, and per-pixel differences
 * are the wrong unit anyway: antialiasing, a blinking caret and a clock in the
 * corner all differ by a pixel and none of them is the change. Blocks that
 * differ by more than a threshold are marked, neighbouring marked blocks are
 * merged into regions, and small isolated regions are dropped.
 *
 * And it is **a suggestion, never an edit**. It returns rectangles; whether one
 * becomes an annotation is the user's click. An automatic box that silently
 * lands on the wrong thing is worse than no box at all in a document somebody
 * is going to attach to a ticket.
 *
 * Pure: two RGBA buffers in, rectangles out. No canvas, no DOM.
 */

/** Side of a comparison block, in the pixels of the images passed in. */
export const BLOCK = 8

export const DEFAULTS = Object.freeze({
  /** Per-channel difference, 0-255, before a pixel counts as different. */
  threshold: 26,
  /** Fraction of a block's pixels that must differ before the block does. */
  density: 0.18,
  /**
   * Blocks that must have changed before a region is real.
   *
   * This is the noise floor, and it is counted on the blocks that actually
   * differ rather than on the rectangle drawn around them. A caret lights one
   * block; padding it out to three by three would clear any area threshold, so
   * measuring the padded box is measuring the padding.
   */
  minBlocks: 4,
  /** Regions smaller than this share of the image are noise — a caret, a clock. */
  minArea: 0.0006,
  /** Regions bigger than this are "the whole screen changed", which says nothing. */
  maxArea: 0.62,
  /** Merge regions whose gaps are smaller than this many blocks. */
  gap: 2,
  /** Never return more than this many, newest and largest first. */
  limit: 6,
  /** Grow the result by this many blocks, so a box does not clip its own subject. */
  pad: 1
})

/**
 * Rectangles covering what differs between two same-sized RGBA buffers.
 *
 * @param {Uint8ClampedArray|Uint8Array} before
 * @param {Uint8ClampedArray|Uint8Array} after
 * @param {{width: number, height: number}} size  dimensions both buffers share
 * @returns {Array<{x: number, y: number, width: number, height: number, area: number}>}
 */
export function diffRegions(before, after, { width, height, ...options } = {}) {
  const opts = { ...DEFAULTS, ...options }
  if (!width || !height) return []
  const expected = width * height * 4
  // Differently sized captures are not comparable, and guessing at an alignment
  // would produce confident nonsense. A window that was resized between steps
  // simply gets no suggestion.
  if (before?.length !== expected || after?.length !== expected) return []

  const cols = Math.ceil(width / BLOCK)
  const rows = Math.ceil(height / BLOCK)
  const changed = new Uint8Array(cols * rows)

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const x0 = bx * BLOCK
      const y0 = by * BLOCK
      const x1 = Math.min(x0 + BLOCK, width)
      const y1 = Math.min(y0 + BLOCK, height)

      let differing = 0
      let total = 0
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * 4
        for (let x = x0; x < x1; x++, i += 4) {
          total++
          // Max across channels rather than a sum: a change confined to one
          // channel — a red error message appearing on grey — is exactly the
          // kind this should catch, and averaging would dilute it.
          const d = Math.max(
            Math.abs(before[i] - after[i]),
            Math.abs(before[i + 1] - after[i + 1]),
            Math.abs(before[i + 2] - after[i + 2])
          )
          if (d > opts.threshold) differing++
        }
      }
      if (total && differing / total >= opts.density) changed[by * cols + bx] = 1
    }
  }

  const regions = merge(changed, cols, rows, opts.gap)
  const imageArea = width * height
  const toRect = (region) => ({
    x: region.x0 * BLOCK,
    y: region.y0 * BLOCK,
    width: Math.min((region.x1 + 1) * BLOCK, width) - region.x0 * BLOCK,
    height: Math.min((region.y1 + 1) * BLOCK, height) - region.y0 * BLOCK
  })

  return regions
    // Judged before growing, on what changed rather than on the padding.
    .filter((region) => {
      if (region.blocks < opts.minBlocks) return false
      const bare = toRect(region)
      const share = (bare.width * bare.height) / imageArea
      return share >= opts.minArea && share <= opts.maxArea
    })
    .map((region) => toRect(grow(region, opts.pad, cols, rows)))
    .map((rect) => ({ ...rect, area: (rect.width * rect.height) / imageArea }))
    .sort((a, b) => b.area - a.area)
    .slice(0, opts.limit)
}

/**
 * Connected groups of changed blocks, allowing a gap.
 *
 * A flood fill over the block grid. The gap matters: text that changes leaves
 * the spaces between its words unchanged, and without tolerance a single edited
 * sentence comes back as eleven separate boxes.
 */
function merge(changed, cols, rows, gap) {
  const seen = new Uint8Array(cols * rows)
  const regions = []
  const stack = []

  for (let start = 0; start < changed.length; start++) {
    if (!changed[start] || seen[start]) continue

    let x0 = start % cols
    let x1 = x0
    let y0 = Math.floor(start / cols)
    let y1 = y0
    let blocks = 0

    stack.push(start)
    seen[start] = 1

    while (stack.length) {
      const at = stack.pop()
      blocks++
      const cx = at % cols
      const cy = Math.floor(at / cols)
      if (cx < x0) x0 = cx
      if (cx > x1) x1 = cx
      if (cy < y0) y0 = cy
      if (cy > y1) y1 = cy

      for (let dy = -gap; dy <= gap; dy++) {
        for (let dx = -gap; dx <= gap; dx++) {
          if (!dx && !dy) continue
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const next = ny * cols + nx
          if (changed[next] && !seen[next]) { seen[next] = 1; stack.push(next) }
        }
      }
    }
    regions.push({ x0, y0, x1, y1, blocks })
  }
  return regions
}

const grow = (region, pad, cols, rows) => ({
  x0: Math.max(0, region.x0 - pad),
  y0: Math.max(0, region.y0 - pad),
  x1: Math.min(cols - 1, region.x1 + pad),
  y1: Math.min(rows - 1, region.y1 + pad)
})

/**
 * Move rectangles from the size they were computed at to the size they are for.
 *
 * The comparison runs on thumbnails — a 480px copy is plenty to find a changed
 * region and roughly sixty times less work than the original — but the
 * annotation has to land on the full-size image. Rounded outwards, so a box
 * never ends up a pixel inside the thing it is pointing at.
 */
export function scaleRegions(regions, from, to) {
  if (!from?.width || !from?.height || !to?.width || !to?.height) return []
  const sx = to.width / from.width
  const sy = to.height / from.height
  return regions.map((rect) => {
    const x = Math.max(0, Math.floor(rect.x * sx))
    const y = Math.max(0, Math.floor(rect.y * sy))
    return {
      ...rect,
      x,
      y,
      width: Math.min(to.width - x, Math.ceil(rect.width * sx)),
      height: Math.min(to.height - y, Math.ceil(rect.height * sy))
    }
  })
}
