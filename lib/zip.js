/**
 * A ZIP writer, store-only.
 *
 * No compression, deliberately. Everything going into these archives is already
 * compressed — PNG, JPEG, WebP, WebM — so deflating it again costs CPU to save
 * roughly nothing, and `CompressionStream` is not available in every engine this
 * has to run in. Stored entries are also the one ZIP shape every unarchiver on
 * every platform reads without argument.
 *
 * Zip64 is not implemented: the 4 GB and 65,535-entry ceilings are far past what
 * a documentation export is, and pretending otherwise would be more code than
 * the feature deserves.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/**
 * DOS date and time, which is what a ZIP header carries.
 *
 * Two-second resolution and a 1980 epoch, both of which are simply what the
 * format is. A date before 1980 clamps rather than wrapping into nonsense.
 */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

const encoder = new TextEncoder()

class Writer {
  constructor() { this.parts = []; this.length = 0 }
  bytes(array) { this.parts.push(array); this.length += array.length }
  u16(value) { this.bytes(new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF])) }
  u32(value) {
    this.bytes(new Uint8Array([
      value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF
    ]))
  }
}

/**
 * @param {Array<{path: string, data: Blob|Uint8Array|string}>} entries
 * @returns {Promise<Blob>}
 */
export async function zip(entries, when = new Date()) {
  const stamp = dosStamp(when)
  const out = new Writer()
  const directory = []

  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const data = entry.data instanceof Uint8Array
      ? entry.data
      : typeof entry.data === 'string'
        ? encoder.encode(entry.data)
        : new Uint8Array(await entry.data.arrayBuffer())

    const sum = crc32(data)
    const offset = out.length

    out.u32(0x04034B50)  // local file header
    out.u16(20)          // version needed
    // Bit 11 says the name is UTF-8. Without it, anything non-ASCII in a
    // filename is decoded as the archiver's local code page.
    out.u16(0x0800)
    out.u16(0)           // stored
    out.u16(stamp.time)
    out.u16(stamp.date)
    out.u32(sum)
    out.u32(data.length)
    out.u32(data.length)
    out.u16(name.length)
    out.u16(0)
    out.bytes(name)
    out.bytes(data)

    directory.push({ name, sum, size: data.length, offset })
  }

  const directoryStart = out.length
  for (const entry of directory) {
    out.u32(0x02014B50)  // central directory header
    out.u16(20)          // version made by
    out.u16(20)          // version needed
    out.u16(0x0800)
    out.u16(0)
    out.u16(stamp.time)
    out.u16(stamp.date)
    out.u32(entry.sum)
    out.u32(entry.size)
    out.u32(entry.size)
    out.u16(entry.name.length)
    out.u16(0)           // extra
    out.u16(0)           // comment
    out.u16(0)           // disk number
    out.u16(0)           // internal attributes
    out.u32(0)           // external attributes
    out.u32(entry.offset)
    out.bytes(entry.name)
  }

  const directorySize = out.length - directoryStart
  out.u32(0x06054B50)    // end of central directory
  out.u16(0)
  out.u16(0)
  out.u16(directory.length)
  out.u16(directory.length)
  out.u32(directorySize)
  out.u32(directoryStart)
  out.u16(0)

  return new Blob(out.parts, { type: 'application/zip' })
}
