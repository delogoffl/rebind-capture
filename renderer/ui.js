/**
 * DOM helpers and the icon set.
 *
 * `el()` builds nodes rather than parsing HTML strings. Every string that ends
 * up on screen here came from somewhere — a window title, a file path, a
 * session label the user typed — and `innerHTML` on any of those is an
 * injection waiting for the first window called `<img onerror=...>`. Building
 * nodes and setting `textContent` makes that structurally impossible rather
 * than a thing to remember.
 */

import { metrics, place, THEMES as KEY_THEMES } from '../lib/keys.js'

export const $ = (id) => document.getElementById(id)
export const all = (sel, root = document) => [...root.querySelectorAll(sel)]

/**
 * @param {string} tag  'button.btn.quiet' — tag, then classes
 * @param {object} [props]  textContent, attributes, dataset, on* handlers
 * @param {Array} [kids]
 */
export function el(tag, props = {}, kids = []) {
  const [name, ...classes] = tag.split('.')
  const node = document.createElement(name || 'div')
  if (classes.length) node.className = classes.join(' ')

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue
    if (key === 'text') node.textContent = String(value)
    else if (key === 'html') throw new Error('el() does not take html — build nodes')
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'style') Object.assign(node.style, value)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (key in node && key !== 'title' && typeof value !== 'object') {
      node[key] = value
    } else {
      node.setAttribute(key, String(value))
    }
  }

  for (const kid of [].concat(kids)) {
    if (kid === null || kid === undefined || kid === false) continue
    node.append(typeof kid === 'string' ? document.createTextNode(kid) : kid)
  }
  return node
}

/* ────────────────────────────────────────────────────────────────── icons */

const SVG = 'http://www.w3.org/2000/svg'

/**
 * One place for every glyph.
 *
 * Inline paths rather than an icon font or a sprite file: a font is a network
 * request and a licence, and at two dozen glyphs a sprite is indirection for
 * its own sake.
 */
const PATHS = {
  camera: ['M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.4-2h7.8l1.4 2h2.2A1.5 1.5 0 0 1 21 8.5v10A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5Z', 'M15.6 13a3.6 3.6 0 1 1-7.2 0 3.6 3.6 0 0 1 7.2 0'],
  monitor: ['M2.5 4.5h19v13h-19z', 'M8.5 20.5h7M12 17.5v3'],
  window: ['M3 5.5h18v13H3z', 'M3 9.5h18M6.2 7.5h.01M8.9 7.5h.01'],
  crop: ['M7 2v15h15M2 7h15v15'],
  record: ['M12 5.6a6.4 6.4 0 1 1 0 12.8 6.4 6.4 0 0 1 0-12.8'],
  stop: ['M7.5 7.5h9v9h-9z'],
  pause: ['M9.3 5.6v12.8M14.7 5.6v12.8'],
  play: ['M8.5 5.4v13.2L19 12z'],
  layers: ['M12 2.8 21.6 7.6 12 12.4 2.4 7.6Z', 'M2.4 12.4 12 17.2l9.6-4.8M2.4 16.9 12 21.7l9.6-4.8'],
  download: ['M12 3.5v12M7.5 11l4.5 4.5 4.5-4.5M4 20.5h16'],
  trash: ['M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5 7.5 20h9l1-13.5'],
  check: ['M4.5 12.5 9.5 17.5 19.5 6.5'],
  clock: ['M20.2 12a8.2 8.2 0 1 1-16.4 0 8.2 8.2 0 0 1 16.4 0', 'M12 6.8V12l3.4 2.1'],
  cursor: ['M6.6 3.4 19 12.2l-5.3 1.1 2.6 5.4-2.3 1.1-2.6-5.4-3.8 3.8Z'],
  mic: ['M12 2.6a2.9 2.9 0 0 1 2.9 2.9v5.9a2.9 2.9 0 1 1-5.8 0V5.5A2.9 2.9 0 0 1 12 2.6Z', 'M18.6 11v.6a6.6 6.6 0 0 1-13.2 0V11M12 18.2v3.2M8.6 21.4h6.8'],
  speaker: ['M11 5 6.4 8.9H2.6v6.2h3.8L11 19Z', 'M15.2 9a4.3 4.3 0 0 1 0 6M18.4 5.6a9 9 0 0 1 0 12.8'],
  alert: ['M12 3.4 2.6 20.6h18.8Z', 'M12 10.2v4M12 17.4h.01'],
  bolt: ['M13.4 2.4 4.2 13.6h6.3l-.9 8 9.2-11.2h-6.3Z'],
  folder: ['M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18Z'],
  refresh: ['M20.5 12a8.5 8.5 0 1 1-2.5-6', 'M18 3v3.4h-3.4'],
  keyboard: ['M2.5 6h19v12h-19z', 'M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8.5 14h7'],
  shield: ['M12 2.6 4.2 5.8v6.1c0 4.6 3.2 8.4 7.8 9.5 4.6-1.1 7.8-4.9 7.8-9.5V5.8Z', 'M8.8 12.1 11 14.3l4.2-4.4'],
  sun: ['M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', 'M12 2v2.2M12 19.8V22M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2 12h2.2M19.8 12H22M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6'],
  moon: ['M20.8 13.1A8.6 8.6 0 1 1 10.9 3.2a6.7 6.7 0 0 0 9.9 9.9Z'],
  file: ['M7 3h7.5L19 7.5V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z', 'M14 3v5h5'],
  plus: ['M12 5v14M5 12h14'],
  pen: ['M16.5 3.6 20.4 7.5 8.4 19.5l-4.9 1 1-4.9Z', 'M14.2 5.9l3.9 3.9'],
  gauge: ['M20.2 15.5a9 9 0 1 0-16.4 0', 'M12 13.5 15.8 9.7'],
  eye: ['M2.6 12S6.6 5 12 5s9.4 7 9.4 7-4 7-9.4 7-9.4-7-9.4-7Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0']
}

const FILLED = new Set(['record', 'stop', 'play', 'cursor'])

export function icon(name, cls) {
  const paths = PATHS[name]
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  if (cls) svg.setAttribute('class', cls)
  const filled = FILLED.has(name)
  svg.setAttribute('fill', filled ? 'currentColor' : 'none')
  if (!filled) {
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
  }
  for (const d of paths || []) {
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/* ─────────────────────────────────────────────────────────────── format */

export const mmss = (ms) => {
  const total = Math.floor(Math.max(0, ms || 0) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

export const humanBytes = (bytes) => {
  if (!bytes || bytes < 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export const when = (ts) => {
  const date = new Date(ts)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/* ─────────────────────────────────────────────────────────────── toasts */

/**
 * Transient by design.
 *
 * Anything the user has to act on belongs in the view where they can act on it;
 * a toast is for telling them something already happened. The one exception is
 * the optional action, which is always a shortcut to somewhere — never the only
 * way to do a thing.
 */
export function toast(message, { tone = 'ok', action, onAction, timeout = 4200 } = {}) {
  const host = $('toasts')
  const node = el(`div.toast${tone === 'ok' ? '' : `.${tone}`}`, {}, [
    el('span.dot'),
    el('span', { text: message }),
    action ? el('button.go', { type: 'button', text: action, onClick: () => { onAction?.(); dismiss() } }) : null
  ])
  host.append(node)

  let timer = 0
  const dismiss = () => {
    clearTimeout(timer)
    node.classList.add('leaving')
    node.addEventListener('animationend', () => node.remove(), { once: true })
  }
  timer = setTimeout(dismiss, timeout)
  // More than four at once is a log, not a notification.
  while (host.children.length > 4) host.firstElementChild.remove()
  return dismiss
}

/* ──────────────────────────────────────────────────────────────── images */

/**
 * Bytes from the library to something an `<img>` can show.
 *
 * Object URLs, not data URLs: a 4K PNG base64-encoded is a 30MB string, and a
 * grid of thirty of them is how a renderer runs out of memory. The caller owns
 * the revoke, which is why every view that makes these keeps a set.
 */
export function bytesToUrl(bytes, type = 'image/png') {
  return URL.createObjectURL(new Blob([bytes], { type }))
}

/** A small, cheap copy for a grid, made on a canvas rather than by CSS. */
export async function thumbnail(bytes, width = 480, type = 'image/png') {
  const bitmap = await createImageBitmap(new Blob([bytes], { type }))
  const scale = Math.min(1, width / bitmap.width)
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)))
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * The JPEG the PDF writer wants.
 *
 * `/DCTDecode` copies the compressed bytes into the PDF untouched, so the
 * encoder here is the only place the image is re-compressed — which is why the
 * cap is on width rather than on quality: a 4K screenshot at 1600px reads
 * perfectly on an A4 page and is a fifth of the file.
 */
export async function toJpeg(bytes, quality = 0.85, maxWidth = 1600) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const scale = Math.min(1, maxWidth / bitmap.width)
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  // JPEG has no alpha; without a ground, transparency composites to black.
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, width, height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality }), width, height }
}

/**
 * Draw the keypress strip into the capture.
 *
 * Into the pixels, for the same reason as the pointer ring: a HUD that only
 * exists in this app's viewer is not evidence. The PNG somebody attaches to a
 * ticket has to show what was typed, and a separate overlay is one export away
 * from being lost.
 *
 * The live overlay is hidden for the moment the shutter fires and its caps are
 * drawn back in here, rather than letting the on-screen window be captured.
 * That is what makes this work for a window or a region capture — neither of
 * which composites an overlay that is merely floating above them — and it keeps
 * the strip at the image's scale rather than at the screen's.
 */
export async function burnKeys(bytes, caps, settings) {
  if (!caps?.length) return bytes

  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()

  drawCaps(ctx, caps, settings, canvas)

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Paint the strip onto a 2D context.
 *
 * Shared by the screenshot burn-in and by the recorder's frame compositor, so
 * a keycap looks the same in a PNG as it does in the video beside it. It draws
 * into whatever context it is handed and returns nothing — the caller owns the
 * surface, which is what lets one of them use an `OffscreenCanvas` once and the
 * other a live canvas thirty times a second.
 */
export function drawCaps(ctx, caps, settings, frame) {
  if (!caps?.length) return

  // Sized against the frame, not the screen: a 34px cap is bold on a 1280px
  // capture and nearly invisible on a 4K one.
  const scale = Math.max(1, Math.min(frame.width, frame.height) / 900)
  const m = metrics(settings.keypressSize, scale)
  const theme = KEY_THEMES[settings.keypressTheme] || KEY_THEMES.dark

  ctx.save()
  ctx.font = `600 ${m.font}px 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`
  ctx.textBaseline = 'middle'

  const boxes = caps.map((cap) => ({
    text: cap.text,
    width: Math.max(m.minWidth, ctx.measureText(cap.text).width + m.padding * 2)
  }))

  const stripWidth = boxes.reduce((n, b) => n + b.width, 0) + m.gap * Math.max(0, boxes.length - 1)
  const at = place(settings.keypressPosition, frame, { width: stripWidth, height: m.height })

  let x = at.x
  for (const box of boxes) {
    roundRect(ctx, x, at.y, box.width, m.height, m.radius)
    ctx.fillStyle = theme.bg
    ctx.fill()
    // The heavier bottom edge is what makes a rectangle read as a key.
    ctx.strokeStyle = theme.edge
    ctx.lineWidth = Math.max(1, scale)
    ctx.stroke()

    ctx.fillStyle = theme.fg
    ctx.textAlign = 'center'
    ctx.fillText(box.text, x + box.width / 2, at.y + m.height / 2 + m.height * 0.02)
    x += box.width + m.gap
  }
  ctx.restore()
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/**
 * Draw the pointer ring into the capture.
 *
 * Into the pixels, not over them as a layer. A marker that only exists in the
 * viewer is not evidence — the PNG somebody attaches to a ticket has to show
 * where the click was, and a separate overlay is one export away from being
 * lost.
 */
export async function markCursor(bytes, cursor, { color = '#06B6D4', size = 'md' } = {}) {
  if (!cursor) return bytes
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()

  // Scaled against the image, not fixed: a 34px ring is bold on a 1280px
  // screenshot and nearly invisible on a 4K one.
  const base = { sm: 0.014, md: 0.021, lg: 0.03 }[size] ?? 0.021
  const radius = Math.max(10, Math.round(Math.min(canvas.width, canvas.height) * base))
  const line = Math.max(2, Math.round(radius * 0.16))

  ctx.save()
  ctx.beginPath()
  ctx.arc(cursor.x, cursor.y, radius, 0, Math.PI * 2)
  ctx.fillStyle = `${color}2E`
  ctx.fill()
  // A dark ring under the bright one, so the marker survives a light background
  // as well as a dark one.
  ctx.lineWidth = line + 2
  ctx.strokeStyle = 'rgba(0, 0, 0, .35)'
  ctx.stroke()
  ctx.lineWidth = line
  ctx.strokeStyle = color
  ctx.stroke()
  ctx.restore()

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}
