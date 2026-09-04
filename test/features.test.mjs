/**
 * The three features, at the seams the unit tests cannot reach.
 *
 * `annotate`, `diff`, `marks` and `manifest` are pure and tested directly; the
 * editor, the canvas and the video element are exercised for real by
 * `test/bets-probe.mjs` inside Electron. What is left is the wiring between
 * them — the order of operations, and which switch controls what — and almost
 * every assertion below is about a way one of these could appear to work while
 * being quietly wrong:
 *
 *   an annotation saved from the preview instead of the original, so every
 *   marked-up capture is silently downsampled;
 *
 *   a digest taken at export instead of at capture, which certifies the file as
 *   it was *after* any tampering;
 *
 *   the keypress HUD's switch also gating step collection, so turning off a
 *   cosmetic overlay silently disables an unrelated feature.
 *
 * None of those break anything visibly. That is exactly why they are here.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * Source with comments stripped.
 *
 * Assertions about what code does *not* do keep matching the comment that
 * explains why it does not do it — the note above a fix names the thing it
 * replaced, which is the string the test is looking for.
 */
const code = (file) => readFileSync(join(ROOT, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** The body of a named function, so an assertion is scoped to it. */
function body(file, name) {
  const text = code(file)
  const start = text.search(new RegExp(`(async )?function ${name}\\(`))
  assert.ok(start > 0, `${name} is gone from ${file}`)
  const rest = text.slice(start)
  // Functions in these files are indented one level inside a mount function,
  // so a two-space closing brace ends them.
  const end = rest.search(/\n {2}\}/)
  return end > 0 ? rest.slice(0, end) : rest
}

const LIBRARY = 'renderer/view-library.js'
const RECORD = 'renderer/view-record.js'

/* ══════════════════════════════════════════════════ marking up a capture */

describe('burning marks into a capture', () => {
  test('the marks go into the pixels, not a viewer-only layer', () => {
    // The rule the cursor ring and the keypress caps already follow: the PNG is
    // what gets attached to the ticket, so that is what has to carry the mark.
    const fn = body(LIBRARY, 'annotateStep')
    assert.match(fn, /burnAnnotations\(bytes, marks\)/)
    assert.match(fn, /name: step\.file/)
    assert.match(fn, /name: step\.thumb/, 'the grid would otherwise keep showing the unmarked image')
  })

  test('re-encoding happens at the original size', () => {
    // Burning from the preview would downsample every annotated capture in the
    // library, and nobody would notice until an exported PDF looked soft.
    const fn = code('renderer/editor.js').slice(
      code('renderer/editor.js').indexOf('export async function burnAnnotations'))
    assert.match(fn, /canvas\.width = image\.width/)
    assert.match(fn, /canvas\.height = image\.height/)
  })

  test('the untouched copy is written once, before the first edit', () => {
    // Writing it on every edit would "restore" to the previous edit's output,
    // and the original would be gone with nothing having said so.
    assert.match(body(LIBRARY, 'annotateStep'),
      /if \(!step\.annotations\?\.length && !destroys\)[\s\S]{0,160}writeAsset/)
  })

  test('a redaction deletes it, and that is the whole difference', () => {
    const fn = body(LIBRARY, 'annotateStep')
    assert.match(fn, /const destroys = hasRedaction\(marks\)/)
    assert.match(fn, /if \(destroys\) await api\.library\.removeAsset/)
  })

  test('and the editor asks before doing it', () => {
    const editor = code('renderer/editor.js')
    assert.match(editor, /hasRedaction\(keep\)[\s\S]{0,500}await confirm\(/)
    assert.match(editor, /if \(!ok\) return/, 'and a "no" has to stop the save')
  })

  test('a redaction is opaque, never a blur', () => {
    // Blur and pixelation have been reversed in practice, and a translucent
    // black leaves the text underneath legible at the wrong gamma.
    const draw = code('renderer/annotate-draw.js')
    const fn = draw.slice(draw.indexOf('function redact('), draw.indexOf('\nfunction highlight('))
    assert.match(fn, /fillStyle = '#000000'/)
    assert.match(fn, /globalAlpha = 1/)
    assert.ok(!/filter\s*=|blur\(/i.test(fn), 'a reversible redaction is not a redaction')
  })

  test('redactions are painted last, whatever order they were drawn in', () => {
    // A mark drawn over a redaction would leave a gap in it.
    assert.match(code('renderer/annotate-draw.js'),
      /a\.type !== 'redact'\)[\s\S]{0,140}a\.type === 'redact'\)/)
  })

  test('the pre-edit digest is kept once and never moved', () => {
    // Otherwise a second edit overwrites it and the manifest's "before" value
    // stops referring to what came out of the camera.
    const fn = body(LIBRARY, 'annotateStep')
    assert.match(fn, /if \(!step\.originalSha256\) step\.originalSha256 = step\.sha256/)
    assert.match(fn, /step\.sha256 = await digest\(png\)/)
  })

  test('suggestions are compared on thumbnails and applied to the original', () => {
    // Two 4K decodes per step would make opening the editor feel broken.
    const fn = body(LIBRARY, 'suggestChanges')
    assert.match(fn, /pixels\(previous\.thumb\)/)
    assert.match(fn, /pixels\(step\.thumb\)/)
    assert.match(fn, /scaleRegions\(found, before, \{ width: step\.width, height: step\.height \}\)/)
  })

  test('a capture that has been drawn on says so on the tile', () => {
    // An annotated image and an untouched one look alike at thumbnail size.
    assert.match(code(LIBRARY), /step\.annotations\?\.length[\s\S]{0,120}el\('span\.marked'/)
  })
})

/* ═══════════════════════════════════════════════════ recording a digest */

describe('recording a digest', () => {
  test('a capture is hashed as it is written, not as it is exported', () => {
    // A digest computed while building a pack certifies the file as it was at
    // export time, which is after any alteration would already have happened.
    const app = code('renderer/app.js')
    assert.match(app, /sha256: settings\.hashAssets \? await digest\(png\) : null/)
    assert.ok(app.indexOf('burnKeys(png') < app.indexOf('await digest(png)'),
      'the digest has to cover the bytes that actually reach disk')
  })

  test('a recording is hashed too', () => {
    assert.match(code('renderer/app.js'),
      /sha256: state\.settings\.hashAssets \? await digest\(bytes\) : null/)
  })

  test('the manifest never claims a file the pack does not hold', () => {
    // The md zip lists recordings in the report but does not contain them;
    // claiming them would make an intact pack verify as one with missing files.
    const exp = code('lib/export.js')
    const md = exp.slice(exp.indexOf("if (format === 'md')"), exp.indexOf("if (format === 'pdf')"))
    assert.match(md, /integrity\(\{/)
    assert.ok(!/integrity\(\{\s*\n?\s*session, steps, media/.test(md))
  })

  test('formats with nowhere to put it do not pretend to have one', () => {
    const exp = code('lib/export.js')
    const video = exp.slice(exp.indexOf("if (format === 'video')"), exp.indexOf('if (!steps.length)'))
    assert.ok(!/integrity\(/.test(video), 'a bare .mp4 cannot carry a checksum file')
  })

  test('verification runs in main, where the files are', () => {
    // Streaming hundreds of megabytes of video through IPC so the page could
    // hash it would be slower and pointless when the answer is a verdict.
    assert.match(code('main.cjs'), /ipcMain\.handle\('library:verify'[\s\S]{0,200}verifySession/)
    assert.match(code(LIBRARY), /await api\.library\.verify\(session\.id\)/)
  })

  test('no digest is reported differently from a wrong digest', () => {
    assert.match(body(LIBRARY, 'verify'),
      /result\.unverified\.length && !result\.modified\.length && !result\.missing\.length/,
      'a session captured before hashing existed is not a tampering finding')
  })

  test('the export honours the setting', () => {
    assert.match(code(LIBRARY), /manifest: state\.settings\.exportManifest/)
  })
})

/* ══════════════════════════════════════ cutting a recording into steps */

describe('cutting a recording into steps', () => {
  test('the hook runs if either feature needs it', () => {
    // Two independent reasons, one hook. Deriving its lifetime from whichever
    // feature was wired first is what would make turning off the HUD silently
    // disable step collection.
    const main = code('main.cjs')
    assert.match(main, /const wantHook = \(\) => wantKeys\(\) \|\| marksLive/)
    assert.match(main, /if \(!wantHook\(\)\) stopHook\(\)/)
  })

  test('clicks are collected regardless of the HUD setting', () => {
    const main = code('main.cjs')
    const fn = main.slice(main.indexOf('function onGlobalKey('), main.indexOf('\nfunction onGlobalClick('))
    assert.ok(fn.indexOf('marksLive') < fn.indexOf('if (!current.keypress) return'),
      'the HUD switch must not gate step collection')
    assert.match(main, /uIOhook\.on\('mousedown', onGlobalClick\)/)
    assert.match(main, /uIOhook\.off\('mousedown', onGlobalClick\)/, 'and it has to come off again')
  })

  test('there is a ceiling on what one take may collect', () => {
    // Above it a recording has stopped being documentation.
    assert.match(code('main.cjs'), /marks\.length < MAX_MARKS/)
  })

  test('a take records when it was paused, as ranges not a total', () => {
    // A running total cannot answer "how much pausing happened before this
    // click", and getting that wrong puts every step after the first pause on
    // the wrong frame — which reads as the feature simply not working.
    const record = code(RECORD)
    assert.match(record, /pauses\.push\(\{ from: state\.recording\.pausedAt \}\)/)
    assert.match(record, /if \(open && !open\.to\) open\.to = Date\.now\(\)/)
  })

  test('a take stopped while paused closes its last range', () => {
    // An open range swallows every mark after it.
    assert.match(body(RECORD, 'finish'), /if \(open && !open\.to\) open\.to = Date\.now\(\)/)
  })

  test('the marks are stored with the recording, not consumed at stop', () => {
    // So steps can be extracted later — after watching it back, or on a second
    // pass — instead of only in the moment the take ended.
    assert.match(code(RECORD), /marks: collecting \? seen : \[\]/)
    assert.match(code('lib/session.js'), /marks: Array\.isArray\(media\.marks\)/)
    assert.match(code('lib/session.js'), /pauses: Array\.isArray\(media\.pauses\)/)
  })

  test('stopping always disarms, even when collecting never started', () => {
    // `marks.stop` is also what turns off the hook's other reason for running.
    assert.match(body(RECORD, 'finish'), /await api\.marks\.stop\(\)/)
    assert.match(code(RECORD), /api\.marks\.discard\(\)/, 'and a failed start must not leave it armed')
  })

  test('a failure to arm is said out loud, not silently a no-op', () => {
    assert.match(code(RECORD), /Steps cannot be extracted from this take/)
  })

  test('extraction is never automatic', () => {
    // Sixty steps appearing in the library unasked is not a feature.
    const fn = body(LIBRARY, 'extractSteps')
    assert.match(fn, /await confirm\(\{/)
    assert.match(fn, /if \(!ok\) return/)
    assert.match(fn, /describePlan\(plan\)/, 'and it says how many it will make first')
  })

  test('seeks are sequential, because a video has one playhead', () => {
    const fn = body(LIBRARY, 'extractSteps')
    assert.match(fn, /for \(const mark of plan\) \{[\s\S]{0,240}await seek\(video/)
    assert.ok(!/Promise\.all\([\s\S]{0,120}seek\(/.test(fn),
      'firing seeks in parallel gives every frame whichever seek landed last')
  })

  test('a stuck seek does not hang the app forever', () => {
    assert.match(body(LIBRARY, 'seek'), /setTimeout\([\s\S]{0,80}reject/)
  })

  test('a step from a recording says where it came from', () => {
    assert.match(code(LIBRARY), /from: \{ mediaId: item\.id, offsetMs: mark\.offsetMs/)
  })

  test('the button only appears when there is something to extract', () => {
    // A button that always finds nothing teaches people to stop pressing it.
    assert.match(code(LIBRARY), /item\.marks\?\.length/)
  })

  test('a partial extraction keeps what it managed', () => {
    // Half a document is more use than none, and the steps that landed are
    // correct — rolling them back would throw away good work over a bad seek.
    assert.match(body(LIBRARY, 'extractSteps'), /if \(made\) await api\.library\.save\(session\)/)
  })
})

/* ═══════════════════════════════════════════════════ the shared helper */

describe('setting a custom property', () => {
  test('el() does not drop them on the floor', () => {
    /**
     * `Object.assign(node.style, ...)` ignores anything starting with `--`,
     * silently, because assigning an unknown key to a CSSStyleDeclaration is
     * not an error. A rule reading `var(--swatch)` then resolves to nothing and
     * the element renders with no background — which looks like a CSS mistake
     * and is a JavaScript one. The editor's colour swatches were invisible
     * until this was fixed.
     */
    const ui = code('renderer/ui.js')
    assert.match(ui, /key\.startsWith\('--'\)[\s\S]{0,80}setProperty/)
    assert.ok(!/key === 'style'\) Object\.assign\(node\.style/.test(ui))
  })
})

/**
 * Where a finished recording leaves you.
 *
 * Recording is a bounded activity: it starts, it runs, it stops, and the thing
 * you wanted is the file. The app minimises itself for the take and restores
 * afterwards — and used to restore onto the Record view, the screen for setting
 * up a recording that had just finished. The take was already saved and already
 * listed; seeing it took two more clicks.
 *
 * Captures deliberately keep the old behaviour, and that asymmetry is the part
 * worth pinning: a screenshot is a repeated action, and being pulled out of the
 * Capture view after every shutter would be a worse version of the same
 * complaint.
 */
describe('landing after a take', () => {
  const record = () => code('renderer/view-record.js')
  const capture = () => code('renderer/view-capture.js')
  const library = () => code('renderer/view-library.js')

  test('a finished recording goes to the library', () => {
    assert.match(body(RECORD, 'finish'), /go\('library', landing\)/)
  })

  test('it names the recording, not just the view', () => {
    // Arriving at a list and having to work out which row is the new one is
    // most of the way back to not having been taken there.
    assert.match(record(), /landing = \{ sessionId: state\.session\?\.id, mediaId: entry\.id \}/)
  })

  test('a take that produced nothing leaves you where you can retry', () => {
    // `landing` is set inside the try, after the recording is stored — so a
    // failed take falls through to the catch with it still null.
    const fn = body(RECORD, 'finish')
    assert.match(fn, /if \(landing\) \{/)
    assert.ok(fn.indexOf('await storeRecording') < fn.indexOf('landing ='),
      'the landing must not be set before there is something to land on')
  })

  test('the navigation happens after the window is back', () => {
    // Scrolling a row into view on a minimised window is measuring a layout
    // nobody is looking at.
    const fn = body(RECORD, 'finish')
    assert.ok(fn.indexOf('await api.app.comeBack()') < fn.indexOf('go(\'library\', landing)'))
  })

  test('the toast offers the way back, not the place you already are', () => {
    const text = record()
    assert.match(text, /action: 'Record again'/)
    assert.ok(!/action: 'Library'/.test(text), 'a button pointing at the current screen is not an action')
  })

  test('taking a screenshot does not drag you out of the capture view', () => {
    // Eight shots of the same flow is the normal case.
    const text = capture()
    assert.match(text, /action: 'Library'/, 'the offer stays; the automatic jump is what would not')
    assert.ok(!/\n\s*go\('library'[^)]*\)\s*$/m.test(text.replace(/onAction:[^\n]*/g, '')),
      'capture must not navigate on its own')
  })

  test('the library can be told what to land on', () => {
    const text = library()
    assert.match(text, /async enter\(focus\)/)
    assert.match(text, /if \(focus\?\.sessionId\) openId = focus\.sessionId/,
      'the session holding it has to open, or the row is not in the DOM to find')
    assert.match(text, /async function reveal\(focus\)/)
  })

  test('rows and tiles carry their id, so reveal does not guess by position', () => {
    const text = library()
    assert.match(text, /dataset: \{ on: String\(pickedTapes\.has\(item\.id\)\), id: item\.id \}/)
    assert.match(text, /dataset: \{ id: step\.id \}/)
  })

  test('a stale target is a no-op, not a crash on the way back from a take', () => {
    const fn = body(LIBRARY, 'reveal')
    assert.match(fn, /if \(!focus\) return/)
    assert.match(fn, /if \(!target\) return/)
  })

  test('routing passes the target through rather than the view guessing', () => {
    const app = code('renderer/app.js')
    assert.match(app, /export function go\(name, focus\)/)
    assert.match(app, /mounted\.get\(name\)\.enter\?\.\(focus\)/)
    assert.match(app, /export function refreshView\(name, focus\)/)
  })
})

/**
 * The container a recording is written in.
 *
 * A codec string is a promise about what the file will contain, and asking the
 * muxer for an audio codec when the stream has no audio track is a promise
 * that cannot be kept. The file still plays start to finish, so it looks fine
 * — but it cannot be seeked: `currentTime` reports the position asked for
 * while the decoder goes on presenting an earlier frame.
 *
 * Measured in `test/seek-probe.mjs`, recording the same clip ten ways and
 * seeking to four known moments in each:
 *
 *   mp4;codecs=avc1.42E01E,mp4a.40.2   no audio track   326 KB, 1 of 4 wrong
 *   mp4;codecs=avc1.42E01E,mp4a.40.2   with audio       692 KB, correct
 *   mp4;codecs=avc1.42E01E             either           644-713 KB, correct
 *   mp4 / every webm variant           either           correct
 *
 * Exactly one combination fails, at half the byte count of every other — and
 * it was the app's default, since the pinned mp4 string was first in the list
 * and `recordAudio` and `recordMic` are both off out of the box.
 */
describe('choosing a container', () => {
  const record = () => code('renderer/view-record.js')

  /** The mime strings inside a named list in the record view. */
  const list = (name) => {
    const text = record()
    const at = text.indexOf(`const ${name} = [`)
    assert.ok(at > 0, `${name} is gone`)
    const block = text.slice(at, text.indexOf('\n]', at))
    const found = [...block.matchAll(/mimeType: '([^']*)'/g)].map((m) => m[1])
    assert.ok(found.length > 0, `${name} lists no containers`)
    return found
  }

  test('a silent recording is never offered an audio codec', () => {
    for (const mime of list('VIDEO_ONLY')) {
      assert.ok(!/mp4a|opus|vorbis/.test(mime), `${mime} promises audio a silent stream cannot provide`)
    }
  })

  test('a recording with audio still gets one', () => {
    // Otherwise the fix for the silent case would quietly drop the narration.
    const withAudio = list('WITH_AUDIO')
    assert.ok(withAudio.some((m) => /mp4a/.test(m)))
    assert.ok(withAudio.some((m) => /opus/.test(m)))
  })

  test('the two lists agree on preference order', () => {
    // Same containers, same order, differing only in whether audio is named —
    // so turning the microphone on cannot silently change the file format.
    const strip = (m) => m.replace(/,?(mp4a\.40\.2|opus)/g, '')
    assert.deepEqual(list('VIDEO_ONLY').map(strip), list('WITH_AUDIO').map(strip))
  })

  test('the choice follows the stream, not the settings', () => {
    // System audio can be asked for and refused — the Windows loopback does
    // not attach to a window source — and the microphone can be missing. Both
    // fall back to recording silently while the settings still say audio was
    // wanted, so the settings are the wrong thing to ask.
    const text = record()
    assert.match(text, /pickContainer\(stream\.getAudioTracks\(\)\.length > 0\)/)
    assert.ok(!/pickContainer\(state\.settings\.record/.test(text))
  })

  test('the compositor carries audio through, so the count stays honest', () => {
    // With the keypress HUD on, what gets recorded is a canvas copy. If that
    // copy dropped the audio tracks, the container choice would be right for
    // the wrong reason and the narration would be gone.
    assert.match(record(), /for \(const track of base\.getAudioTracks\(\)\) out\.addTrack\(track\)/)
  })
})

/**
 * The player.
 *
 * A bare `<video controls>` was doing this, which is the browser's player and
 * not this app's: different on every platform, styled like nothing else here,
 * and — the part that actually matters — unable to say anything about what it
 * is playing.
 *
 * The reason it is worth owning is the timeline. A recording carries the
 * clicks and keystrokes that happened during it, so they can be drawn as ticks
 * along the scrubber: the dense stretch is where the work was, the gap is
 * where you were reading, and clicking a tick jumps to that action. No
 * third-party player can show that, because none of them knows what a mark is.
 */
describe('playing a recording', () => {
  const library = () => code(LIBRARY)
  const css = () => code('renderer/styles.css')

  test('the chrome is ours, not the browser default', () => {
    const fn = body(LIBRARY, 'playTape')
    assert.match(fn, /class: 'pv-video'/)
    assert.ok(!/controls: true/.test(fn), 'the native control bar is what this replaces')
  })

  test('the timeline is built from the same plan the extraction uses', () => {
    // A second implementation would drift, and then a tick would sit somewhere
    // a step is not — with the recording open in front of the user.
    assert.match(body(LIBRARY, 'playTape'), /planSteps\(item\.marks/)
  })

  test('a tick seeks to its action', () => {
    assert.match(library(), /video\.currentTime = a\.offsetMs \/ 1000/)
  })

  test('an unknown duration does not draw an empty bar forever', () => {
    /**
     * MediaRecorder output can report `Infinity` until the whole file has been
     * walked, and a progress bar dividing by that renders nothing while
     * looking like it works. The stored duration is the measured wall clock of
     * the take and is always a real number.
     */
    // Scoped to playTape: `duration` and `close` are arrow consts inside it,
    // which the function-declaration helper cannot find.
    const fn = body(LIBRARY, 'playTape')
    assert.match(fn, /const duration = \(\) => \{[\s\S]{0,220}Number\.isFinite\(known\)/)
    assert.match(fn, /item\.durationMs \|\| 0/)
  })

  test('the keyboard does not swallow the window shortcuts', () => {
    // A player that eats Ctrl+W is a player people close by force-quitting.
    assert.match(library(), /if \(event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey\) return/)
  })

  test('Escape closes it and playback stops', () => {
    // A dialog removed from the DOM while its video plays on is audible and
    // unreachable.
    const fn = body(LIBRARY, 'playTape')
    assert.match(fn, /const close = \(\) => \{[\s\S]{0,120}video\.pause\(\)/)
    assert.match(fn, /removeEventListener\('keydown', onKey, true\)/)
  })

  test('the scrubber has a hit area larger than the bar it draws', () => {
    // The bar is 4px because that reads as precise; 4px is not something
    // anyone can reliably hit.
    const style = css()
    assert.match(style, /\.pv-rail \{[^}]*height: 18px/)
    assert.match(style, /\.pv-played \{[^}]*height: 4px/)
  })

  test('the ticks sit above the bar rather than on it', () => {
    // A dense run of actions must not obscure the progress it annotates.
    assert.match(css(), /\.pv-tick \{[^}]*top: 0/)
  })
})
