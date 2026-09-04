/**
 * Why extracting a frame from a recording sometimes returns the wrong one.
 *
 * A diagnostic, not a test. The previous attempt at this fixed a symptom by
 * guessing — `requestVideoFrameCallback` is the right primitive on paper, and
 * dropping it in made every seek hang instead. So this measures before anything
 * is changed.
 *
 * For each container `view-record.js` would pick from, it records a canvas that
 * changes colour every second, then seeks to known moments and reports:
 *
 *   what the container claims its duration and seekable range are
 *   where `currentTime` actually landed after `seeked`
 *   what colour was drawn, against what should have been there
 *
 * Between them those separate two causes that need different fixes: a
 * *presentation* race (the seek landed, the canvas copied a stale frame) versus
 * a *seek* failure (the file has no duration, so the decoder cannot honour the
 * position it is reporting).
 *
 * Run: node test/seek-probe.mjs
 */

const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`)

require(join(ROOT, 'main.cjs'))

const watchdog = setTimeout(() => {
  log('\nFAIL  diagnostic timed out')
  app.exit(1)
}, 180_000)
watchdog.unref?.()

app.whenReady().then(async () => {
  const win = await new Promise((resolve) => {
    const found = BrowserWindow.getAllWindows()[0]
    if (found) return resolve(found)
    app.on('browser-window-created', (_e, w) => resolve(w))
  })
  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', resolve)
  })
  await new Promise((r) => setTimeout(r, 1500))

  const findings = await win.webContents.executeJavaScript(`(async () => {
    const BANDS = [
      { name: 'red',   css: '#ef4444', rgb: [239, 68, 68] },
      { name: 'green', css: '#22c55e', rgb: [34, 197, 94] },
      { name: 'blue',  css: '#3b82f6', rgb: [59, 130, 246] },
      { name: 'amber', css: '#f59e0b', rgb: [245, 158, 11] }
    ]

    // Exactly the list view-record.js picks from, in its order, so the answer
    // is about what the app actually writes rather than about webm in general.
    const CONTAINERS = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      // The candidate fix: the same video codec, with no audio codec promised.
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4'
    ]
    const supported = CONTAINERS.filter((m) => MediaRecorder.isTypeSupported?.(m))
    const appPicks = supported[0] ?? 'none'

    /**
     * A silent audio track, so a codec string that names one is not a lie.
     *
     * The suspicion under test: the mp4 codec string names an AAC track
     * (mp4a.40.2). A screen recording with audio off has no audio track to
     * give it, and what comes out may be a file whose timing the demuxer
     * cannot follow. No backticks in here — this whole block is inside a
     * template literal, and one would close it.
     */
    function silentTrack() {
      const audio = new AudioContext()
      const dest = audio.createMediaStreamDestination()
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      gain.gain.value = 0.0001
      osc.connect(gain).connect(dest)
      osc.start()
      return { track: dest.stream.getAudioTracks()[0], stop: () => { try { osc.stop(); audio.close() } catch {} } }
    }

    async function record(mimeType, withAudio) {
      const c = document.createElement('canvas')
      c.width = 320; c.height = 240
      const g = c.getContext('2d')
      g.fillStyle = BANDS[0].css; g.fillRect(0, 0, 320, 240)

      const stream = c.captureStream(30)
      let audio = null
      if (withAudio) {
        audio = silentTrack()
        stream.addTrack(audio.track)
      }
      const chunks = []
      const rec = new MediaRecorder(stream, { mimeType })
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }

      const startedAt = Date.now()
      rec.start(200)
      /**
       * Busy content, not a flat fill.
       *
       * A canvas painted one solid colour compresses to almost nothing, and an
       * encoder with nothing to encode emits a handful of frames for several
       * seconds of video. Seeking such a file then returns the wrong frame
       * because there is no frame at the target to return — which measures the
       * fixture rather than the app. Moving noise forces a real frame stream,
       * while the band colour still says unambiguously where in the clip a
       * given frame came from.
       */
      const painter = setInterval(() => {
        const t = Date.now() - startedAt
        const band = Math.min(3, Math.floor(t / 1000))
        g.fillStyle = BANDS[band].css
        g.fillRect(0, 0, 320, 240)
        for (let i = 0; i < 90; i++) {
          g.fillStyle = 'rgba(255,255,255,' + (0.06 + Math.random() * 0.12) + ')'
          g.fillRect(Math.random() * 320, Math.random() * 240, 14, 14)
        }
        // A travelling bar, so there is coherent motion as well as noise.
        g.fillStyle = 'rgba(0,0,0,0.35)'
        g.fillRect((t / 12) % 320, 0, 26, 240)
        // The centre stays the band colour, which is what gets sampled.
        g.fillStyle = BANDS[band].css
        g.fillRect(130, 90, 60, 60)
      }, 33)

      await new Promise((r) => setTimeout(r, 4200))
      clearInterval(painter)
      await new Promise((r) => { rec.onstop = r; rec.stop() })
      for (const t of stream.getTracks()) t.stop()
      audio?.stop()
      return new Blob(chunks, { type: mimeType })
    }

    const nearest = (rgb) => {
      let best = null, bestD = Infinity
      for (const b of BANDS) {
        const d = Math.abs(b.rgb[0] - rgb[0]) + Math.abs(b.rgb[1] - rgb[1]) + Math.abs(b.rgb[2] - rgb[2])
        if (d < bestD) { bestD = d; best = b.name }
      }
      return bestD < 120 ? best : 'other(' + rgb.join(',') + ')'
    }

    const load = async (blob) => {
      const v = document.createElement('video')
      v.src = URL.createObjectURL(blob)
      v.muted = true
      v.playsInline = true
      await new Promise((res, rej) => {
        v.addEventListener('loadeddata', res, { once: true })
        v.addEventListener('error', () => rej(new Error('decode failed')), { once: true })
      })
      return v
    }

    const canvas = document.createElement('canvas')
    canvas.width = 320; canvas.height = 240
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const seekTo = (v, seconds) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('seek timeout')), 6000)
      v.addEventListener('seeked', () => { clearTimeout(t); res() }, { once: true })
      v.currentTime = seconds
    })

    const sample = (v) => {
      ctx.drawImage(v, 0, 0, 320, 240)
      const px = ctx.getImageData(160, 120, 1, 1).data
      return nearest([px[0], px[1], px[2]])
    }

    const targets = [0.5, 1.5, 2.5, 3.5]
    const expected = ['red', 'green', 'blue', 'amber']
    const results = []

    for (const mimeType of supported) {
     for (const withAudio of [false, true]) {
      let blob, probe
      try {
        blob = await record(mimeType, withAudio)
        probe = await load(blob)
      } catch (e) {
        results.push({ mimeType, withAudio, error: String(e?.message || e) })
        continue
      }

      const duration = probe.duration
      const seekable = probe.seekable.length
        ? { start: probe.seekable.start(0), end: probe.seekable.end(0) }
        : null

      // Plain: seek, wait for 'seeked', draw.
      const plain = []
      const vPlain = await load(blob)
      for (const t of targets) {
        await seekTo(vPlain, t)
        plain.push({ landed: vPlain.currentTime, colour: sample(vPlain) })
      }

      // With the duration made known first. Seeking to a huge time and back is
      // the standard trick for forcing a browser to index a stream whose header
      // does not carry a duration.
      const primed = []
      const vPrimed = await load(blob)
      let learnedDuration = null
      try {
        vPrimed.currentTime = 1e6
        await new Promise((res) => {
          const done = () => res()
          vPrimed.addEventListener('seeked', done, { once: true })
          setTimeout(done, 2000)
        })
        learnedDuration = vPrimed.duration
        await seekTo(vPrimed, 0)
      } catch (e) {
        learnedDuration = 'priming failed: ' + String(e?.message || e)
      }
      for (const t of targets) {
        await seekTo(vPrimed, t)
        primed.push({ landed: vPrimed.currentTime, colour: sample(vPrimed) })
      }

      for (const v of [probe, vPlain, vPrimed]) {
        URL.revokeObjectURL(v.src)
        v.remove()
      }

      results.push({
        mimeType,
        withAudio,
        bytes: blob.size,
        duration,
        seekable,
        learnedDuration,
        plain,
        primed,
        wrongPlain: plain.filter((s, i) => s.colour !== expected[i]).length,
        wrongPrimed: primed.filter((s, i) => s.colour !== expected[i]).length
      })
     }
    }

    return { appPicks, supported, targets, expected, results }
  })()`, true)

  clearTimeout(watchdog)

  log('')
  log(`the app would pick   ${findings.appPicks}`)
  log(`supported here       ${findings.supported.join(', ')}`)

  for (const r of findings.results) {
    log('')
    log(`── ${r.mimeType}   ${r.withAudio ? 'WITH audio track' : 'no audio track'}`)
    if (r.error) { log(`   failed: ${r.error}`); continue }
    log(`   ${r.bytes} bytes, duration=${r.duration}, seekable=${JSON.stringify(r.seekable)}`)
    log(`   after priming, duration=${r.learnedDuration}`)
    log('')
    log('   target  expected   plain                 primed')
    findings.targets.forEach((t, i) => {
      const fmt = (s) => `${s.colour.padEnd(9)} @${s.landed.toFixed(2)}s`
      log(`   ${String(t).padEnd(7)} ${findings.expected[i].padEnd(10)} ${fmt(r.plain[i]).padEnd(21)} ${fmt(r.primed[i])}`)
    })
    log('')
    log(`   wrong frames: ${r.wrongPlain}/4 plain, ${r.wrongPrimed}/4 primed`)
  }

  app.exit(0)
})
