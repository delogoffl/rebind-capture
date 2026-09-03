/**
 * A PDF writer, built for exactly one document shape: one step per page, with
 * its number, its title, its screenshot and its metadata.
 *
 * Written by hand rather than pulled in, for the same reason as the ZIP writer
 * beside it: this app ships with two devDependencies and no runtime ones, and a
 * general-purpose PDF library is tens of thousands of lines of supply chain for
 * a document with one image and three lines of text on each page. The subset
 * needed to place a JPEG and a line of Helvetica is what follows.
 *
 * Shared, unmodified, with the ScreenStep browser extension — the same document
 * shape, so the desktop app and the extension produce byte-comparable exports.
 *
 * Images go in as JPEG through `/DCTDecode`, which means the compressed bytes
 * are copied into the file untouched — no re-encoding, no `/FlateDecode`, and no
 * need for a deflate implementation. That is why `toJpeg` exists in image.js.
 *
 * Text is Helvetica from the standard 14, so no font is embedded and no glyph
 * subsetting is needed. The cost of that is WinAnsi: anything outside Latin-1
 * cannot be written, so non-Latin text is transliterated to a marker rather than
 * silently producing the wrong glyph.
 */

const A4 = { width: 595.28, height: 841.89 }
const MARGIN = 42

const encoder = new TextEncoder()

class Bytes {
  constructor() { this.parts = []; this.length = 0 }
  push(part) {
    const array = typeof part === 'string' ? encoder.encode(part) : part
    this.parts.push(array)
    this.length += array.length
    return this
  }
  blob() { return new Blob(this.parts, { type: 'application/pdf' }) }
}

/**
 * A PDF string literal.
 *
 * `(`, `)` and `\` are the three characters that can end or escape a literal
 * early, and an unbalanced parenthesis in a page title is the classic way to
 * produce a file that no reader will open.
 */
function literal(text) {
  const ascii = String(text ?? '')
    // Curly quotes and dashes are what actually turns up in page titles, and
    // they have no WinAnsi equivalent worth the lookup table.
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '?')
  return `(${ascii.replace(/[\\()]/g, (c) => `\\${c}`)})`
}

/** Helvetica at 1000 units/em, averaged. Enough to know when to truncate. */
const WIDTH = 0.52
const fits = (text, size, room) => text.length * size * WIDTH <= room
function truncate(text, size, room) {
  if (fits(text, size, room)) return text
  const max = Math.max(4, Math.floor(room / (size * WIDTH)) - 1)
  return `${String(text).slice(0, max)}...`
}

/**
 * @param {Array<{index:number,title?:string,jpeg:{blob:Blob,width:number,height:number},meta?:object}>} pages
 * @param {{title?:string, session?:object, includeMeta?:boolean}} options
 */
export async function pdf(pages, options = {}) {
  const objects = []
  /** Reserve an object number now, fill the body in later. */
  const reserve = () => { objects.push(null); return objects.length }

  const catalog = reserve()
  const pagesNode = reserve()
  const regular = reserve()
  const bold = reserve()
  const mono = reserve()

  objects[regular - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objects[bold - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  objects[mono - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'

  const pageRefs = []

  for (const page of pages) {
    const image = reserve()
    const content = reserve()
    const pageObject = reserve()

    const jpegBytes = new Uint8Array(await page.jpeg.blob.arrayBuffer())
    objects[image - 1] = {
      dict: `<< /Type /XObject /Subtype /Image /Width ${page.jpeg.width} /Height ${page.jpeg.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>`,
      stream: jpegBytes
    }

    const room = A4.width - MARGIN * 2
    const metaLines = options.includeMeta === false ? [] : metaFor(page.meta)
    const metaHeight = metaLines.length ? metaLines.length * 11 + 10 : 0

    // The image gets whatever is left after the heading and the metadata block,
    // and is scaled to fit rather than cropped — a cropped screenshot in an
    // evidence document is worse than a small one.
    const top = A4.height - MARGIN - 26
    const bottom = MARGIN + metaHeight
    const available = { width: room, height: top - bottom - 12 }
    const scale = Math.min(available.width / page.jpeg.width, available.height / page.jpeg.height, 1)
    const drawWidth = page.jpeg.width * scale
    const drawHeight = page.jpeg.height * scale
    const drawX = MARGIN + (room - drawWidth) / 2
    const drawY = top - 12 - drawHeight

    const heading = `Step ${page.index}${page.title ? ` — ${page.title}` : ''}`
    const ops = [
      // Heading
      'BT', `/F2 13 Tf`, `1 1 1 rg`, 'ET',
      'BT', `/F2 13 Tf`, `0.06 0.09 0.16 rg`,
      `${MARGIN} ${A4.height - MARGIN - 13} Td`,
      `${literal(truncate(heading, 13, room))} Tj`, 'ET',
      // A hairline under it, so pages read as a sequence rather than a pile
      `0.85 0.88 0.92 RG 0.7 w`,
      `${MARGIN} ${A4.height - MARGIN - 21} m ${A4.width - MARGIN} ${A4.height - MARGIN - 21} l S`,
      // Image
      'q', `${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm`,
      `/Im${page.index} Do`, 'Q'
    ]

    metaLines.forEach((line, i) => {
      ops.push(
        'BT', '/F3 7.5 Tf', '0.42 0.45 0.5 rg',
        `${MARGIN} ${MARGIN + metaHeight - 12 - i * 11} Td`,
        `${literal(truncate(line, 7.5, room))} Tj`, 'ET'
      )
    })

    const stream = ops.join('\n')
    objects[content - 1] = {
      dict: `<< /Length ${encoder.encode(stream).length} >>`,
      stream: encoder.encode(stream)
    }

    objects[pageObject - 1] =
      `<< /Type /Page /Parent ${pagesNode} 0 R /MediaBox [0 0 ${A4.width.toFixed(2)} ${A4.height.toFixed(2)}] ` +
      `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R /F3 ${mono} 0 R >> ` +
      `/XObject << /Im${page.index} ${image} 0 R >> >> /Contents ${content} 0 R >>`

    pageRefs.push(pageObject)
  }

  objects[pagesNode - 1] =
    `<< /Type /Pages /Kids [${pageRefs.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesNode} 0 R >>`

  /* ─────────────────────────────────────────────────────────── assemble */

  const out = new Bytes()
  out.push('%PDF-1.4\n')
  // A comment of high bytes marks the file as binary, which stops a transfer
  // that thinks it is text from mangling the JPEG data.
  out.push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]))

  const offsets = []
  objects.forEach((object, i) => {
    offsets[i] = out.length
    out.push(`${i + 1} 0 obj\n`)
    if (typeof object === 'string') {
      out.push(`${object}\n`)
    } else {
      out.push(`${object.dict}\nstream\n`)
      out.push(object.stream)
      out.push('\nendstream\n')
    }
    out.push('endobj\n')
  })

  const xref = out.length
  out.push(`xref\n0 ${objects.length + 1}\n`)
  out.push('0000000000 65535 f \n')
  for (const offset of offsets) {
    out.push(`${String(offset).padStart(10, '0')} 00000 n \n`)
  }

  const info = [
    `/Title ${literal(options.title || 'ScreenStep export')}`,
    `/Producer ${literal('ScreenStep')}`,
    `/CreationDate ${literal(pdfDate(new Date()))}`
  ].join(' ')
  // The Info dictionary is written after the xref deliberately: it is optional,
  // readers do not need it to open the file, and appending it means the table
  // above did not have to reserve a slot for something built at the very end.
  out.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info << ${info} >> >>\n`)
  out.push(`startxref\n${xref}\n%%EOF\n`)

  return out.blob()
}

function pdfDate(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `D:${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

function metaFor(meta) {
  if (!meta) return []
  const lines = []
  if (meta.url) lines.push(meta.url)
  const facts = [
    meta.at ? new Date(meta.at).toLocaleString() : null,
    meta.viewport ? `viewport ${meta.viewport}` : null,
    meta.screen ? `screen ${meta.screen}` : null,
    meta.dpr ? `dpr ${meta.dpr}` : null,
    browserOf(meta.ua)
  ].filter(Boolean)
  if (facts.length) lines.push(facts.join('  ·  '))
  return lines
}

/** Enough of the UA string to be evidence, without pasting the whole thing. */
export function browserOf(ua) {
  if (!ua) return null
  const browser = /Edg\/([\d.]+)/.exec(ua) ? `Edge ${/Edg\/([\d.]+)/.exec(ua)[1]}`
    : /OPR\/([\d.]+)/.exec(ua) ? `Opera ${/OPR\/([\d.]+)/.exec(ua)[1]}`
      : /Firefox\/([\d.]+)/.exec(ua) ? `Firefox ${/Firefox\/([\d.]+)/.exec(ua)[1]}`
        : /Chrome\/([\d.]+)/.exec(ua) ? `Chrome ${/Chrome\/([\d.]+)/.exec(ua)[1]}`
          : /Version\/([\d.]+).*Safari/.exec(ua) ? `Safari ${/Version\/([\d.]+)/.exec(ua)[1]}`
            : null
  const os = /Windows NT 10/.test(ua) ? 'Windows 10/11'
    : /Windows NT ([\d.]+)/.test(ua) ? `Windows ${/Windows NT ([\d.]+)/.exec(ua)[1]}`
      : /Mac OS X ([\d_.]+)/.test(ua) ? `macOS ${/Mac OS X ([\d_.]+)/.exec(ua)[1].replace(/_/g, '.')}`
        : /Android ([\d.]+)/.test(ua) ? `Android ${/Android ([\d.]+)/.exec(ua)[1]}`
          : /Linux/.test(ua) ? 'Linux' : null
  return [browser, os].filter(Boolean).join(' · ') || null
}
