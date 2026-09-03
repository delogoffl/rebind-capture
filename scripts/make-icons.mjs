/**
 * Derive the app icons from the artwork in `icon/`.
 *
 * The product has one piece of real artwork — `icon/iconmain.png` — and
 * everything the OS and the UI show should be that image rather than a second,
 * hand-drawn approximation of it that drifts. So this script decodes it, trims
 * it, and box-filters it down to the sizes an installer and a title bar need.
 *
 * `build/icon.png` is what electron-builder stamps into the bundle and what the
 * BrowserWindow loads at runtime; 512 is the size every platform's packager is
 * happy to downscale from itself.
 *
 * Both the decoder and the encoder are written out here. `zlib` is the only
 * thing either needs and it is in Node's standard library, which keeps this
 * repository at zero dependencies — the same reason the PDF and ZIP writers in
 * `src/export/` are hand-written.
 *
 *   node scripts/make-icons.mjs
 */

import { deflateSync, inflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SOURCE = join(ROOT, 'icon', 'iconmain.png')
const OUT = join(ROOT, 'build')

/**
 * What each size is for: 32 is the Windows taskbar at 100% and 64 at 200%, 256
 * is the title-bar mark on a 3× display, and 512 is the one electron-builder
 * generates every platform's own format from.
 */
const SIZES = [32, 64, 128, 256, 512]

/* ══════════════════════════════════════════════════════════════ PNG decode ══ */

/**
 * Undo the per-scanline filter PNG applies before deflating.
 *
 * Each row carries a filter byte naming one of five predictors, each in terms
 * of the pixel to the left (a), the one above (b) and the one above-left (c).
 * The row above is the already-reconstructed one, which is why this has to run
 * in order and cannot be parallelised.
 */
function unfilter(raw, width, height, channels) {
  const stride = width * channels
  const out = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = y * (stride + 1) + 1
    const to = y * stride
    const above = to - stride

    for (let x = 0; x < stride; x++) {
      const value = raw[line + x]
      const a = x >= channels ? out[to + x - channels] : 0
      const b = y > 0 ? out[above + x] : 0
      const c = y > 0 && x >= channels ? out[above + x - channels] : 0

      let recon
      switch (filter) {
        case 0: recon = value; break
        case 1: recon = value + a; break
        case 2: recon = value + b; break
        case 3: recon = value + ((a + b) >> 1); break
        case 4: {
          // Paeth: pick whichever of a, b, c the linear estimate is nearest.
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          recon = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`Unknown PNG filter ${filter} on row ${y}`)
      }
      out[to + x] = recon & 0xFF
    }
  }
  return out
}

/** Decode a non-interlaced PNG to `{ width, height, pixels }`, RGBA8. */
export function decodePng(buffer) {
  const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
  if (!signature.every((byte, i) => buffer[i] === byte)) {
    throw new Error(`${SOURCE} is not a PNG`)
  }

  let offset = 8
  let header = null
  let palette = null
  let alpha = null
  const parts = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colour: data[9],
        interlace: data[12]
      }
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') alpha = Buffer.from(data)
    // A large PNG is split across many IDATs; the deflate stream spans them.
    else if (type === 'IDAT') parts.push(Buffer.from(data))
    else if (type === 'IEND') break
  }

  if (!header) throw new Error('PNG has no IHDR')
  if (header.interlace) throw new Error('Interlaced PNG is not supported — save it without Adam7')
  if (header.depth !== 8 && header.depth !== 16) {
    throw new Error(`Bit depth ${header.depth} is not supported — save it as 8-bit`)
  }

  const { width, height, depth, colour } = header
  const samples = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour]
  if (!samples) throw new Error(`Unknown PNG colour type ${colour}`)

  const bytes = samples * (depth / 8)
  const flat = unfilter(inflateSync(Buffer.concat(parts)), width, height, bytes)

  // 16-bit samples are read as their high byte: the target is 128px of toolbar
  // icon, where the low byte is below the noise floor of the resize.
  const step = depth === 16 ? 2 : 1
  const pixels = new Uint8ClampedArray(width * height * 4)

  for (let i = 0; i < width * height; i++) {
    const from = i * bytes
    const to = i * 4
    if (colour === 6 || colour === 2) {
      pixels[to] = flat[from]
      pixels[to + 1] = flat[from + step]
      pixels[to + 2] = flat[from + 2 * step]
      pixels[to + 3] = colour === 6 ? flat[from + 3 * step] : 255
    } else if (colour === 0 || colour === 4) {
      const grey = flat[from]
      pixels[to] = pixels[to + 1] = pixels[to + 2] = grey
      pixels[to + 3] = colour === 4 ? flat[from + step] : 255
    } else {
      const index = flat[from]
      pixels[to] = palette[index * 3]
      pixels[to + 1] = palette[index * 3 + 1]
      pixels[to + 2] = palette[index * 3 + 2]
      pixels[to + 3] = alpha?.[index] ?? 255
    }
  }

  return { width, height, pixels }
}

/* ══════════════════════════════════════════════════════════════════ trim ══ */

/**
 * Crop away the transparent margin, then square it up around what is left.
 *
 * The artwork is exported on a canvas with room around it, and that room is
 * dead weight at every size: a 16px icon that spends two of its pixels on empty
 * padding has 12 left for the picture. Finding the alpha bounding box and
 * squaring on its centre buys back about a sixth of the linear scale, which at
 * this size is the difference between reading the shape and not.
 *
 * `padding` keeps a hair of breathing room, because browsers draw the icon
 * hard against the edge of its slot and glowing artwork clipped flush looks cut
 * off rather than tight.
 */
function trimToSquare(source, padding = 0.04) {
  const { width, height, pixels } = source

  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // A threshold rather than > 0: a soft glow fades to alpha 1–2 well
      // outside the shape, and trimming to that trims nothing.
      if (pixels[(y * width + x) * 4 + 3] <= 12) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < left || bottom < top) return source

  const side = Math.round(Math.max(right - left + 1, bottom - top + 1) * (1 + padding))
  const x0 = Math.round((left + right) / 2 - side / 2)
  const y0 = Math.round((top + bottom) / 2 - side / 2)

  const out = new Uint8ClampedArray(side * side * 4)
  for (let y = 0; y < side; y++) {
    const sy = y0 + y
    if (sy < 0 || sy >= height) continue
    for (let x = 0; x < side; x++) {
      const sx = x0 + x
      if (sx < 0 || sx >= width) continue
      const from = (sy * width + sx) * 4
      const to = (y * side + x) * 4
      out[to] = pixels[from]
      out[to + 1] = pixels[from + 1]
      out[to + 2] = pixels[from + 2]
      out[to + 3] = pixels[from + 3]
    }
  }
  return { width: side, height: side, pixels: out }
}

/* ══════════════════════════════════════════════════════════════ downscale ══ */

/**
 * Average every source pixel that falls inside a destination pixel.
 *
 * A box filter over the full footprint, not a nearest-neighbour sample: 1240px
 * of detailed artwork sampled at 16 points is a different picture, and usually
 * a worse-looking one, than 1240px averaged down to 16.
 *
 * Colours are weighted by alpha before averaging and divided back out after.
 * Straight-alpha averaging pulls the RGB of transparent pixels — often black,
 * or whatever the editor left there — into the edge, which is exactly how an
 * icon with a soft glow around it ends up with a dirty halo at 16px.
 */
export function resize(source, size) {
  const { width, height, pixels } = source
  const out = new Uint8ClampedArray(size * size * 4)

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * height) / size)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / size))

    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * width) / size)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / size))

      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4
          const weight = pixels[i + 3] / 255
          r += pixels[i] * weight
          g += pixels[i + 1] * weight
          b += pixels[i + 2] * weight
          a += pixels[i + 3]
          n++
        }
      }

      const mean = a / n
      const to = (y * size + x) * 4
      if (mean > 0) {
        const coverage = mean / 255 * n
        out[to] = Math.round(r / coverage)
        out[to + 1] = Math.round(g / coverage)
        out[to + 2] = Math.round(b / coverage)
      }
      out[to + 3] = Math.round(mean)
    }
  }
  return out
}

/**
 * A light unsharp pass, on the small sizes only.
 *
 * Any box filter is a blur, and at 16–48px the artwork's outlines land on a
 * fraction of a pixel and go soft. Adding back a share of the difference
 * between the image and its own 3×3 mean restores the edge without the ringing
 * a stronger kernel would put around it. 128 and 256 are big enough not to need
 * it, and would show the artefact if they got it.
 */
export function sharpen(pixels, size, amount) {
  const out = new Uint8ClampedArray(pixels)
  const at = (x, y, c) =>
    pixels[(Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))) * 4 + c]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) sum += at(x + dx, y + dy, c)
        }
        const mean = sum / 9
        const value = at(x, y, c)
        out[(y * size + x) * 4 + c] = value + (value - mean) * amount
      }
    }
  }
  return out
}

/* ══════════════════════════════════════════════════════════════ PNG encode ══ */

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

export function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // RGBA
  ihdr[10] = 0  // deflate
  ihdr[11] = 0  // adaptive filtering
  ihdr[12] = 0  // no interlace

  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y++) {
    // Filter 1 (Sub) on photographic artwork compresses appreciably better than
    // none, and costs one subtraction per byte.
    const row = y * (stride + 1)
    raw[row] = 1
    for (let x = 0; x < stride; x++) {
      const value = pixels[y * stride + x]
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0
      raw[row + 1 + x] = (value - left) & 0xFF
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ═══════════════════════════════════════════════════════════════════ run ══ */

// Importing this module for its encoder must not rewrite the icons as a side
// effect — `test/shots.mjs` does exactly that to draw its fixtures.
const RUN_DIRECTLY = process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (RUN_DIRECTLY) run()

function run() {
let file
try {
  file = readFileSync(SOURCE)
} catch {
  console.error(`Cannot read ${SOURCE}. The artwork is the source of the icons — put it back before running this.`)
  process.exit(1)
}

const original = decodePng(file)
const source = trimToSquare(original)
console.log(
  `icon/iconmain.png  ${original.width}×${original.height}  ->  trimmed ${source.width}×${source.height}`
)

mkdirSync(OUT, { recursive: true })
for (const size of SIZES) {
  let pixels = resize(source, size)
  if (size <= 48) pixels = sharpen(pixels, size, size <= 16 ? 0.55 : 0.35)
  const bytes = encodePng(pixels, size)
  writeFileSync(join(OUT, `icon-${size}.png`), bytes)
  console.log(`build/icon-${size}.png  ${String(bytes.length).padStart(6)} bytes`)
  // The one electron-builder and the window both read by name.
  if (size === 512) {
    writeFileSync(join(OUT, 'icon.png'), bytes)
    console.log(`build/icon.png      ${String(bytes.length).padStart(6)} bytes`)
  }
}
}
