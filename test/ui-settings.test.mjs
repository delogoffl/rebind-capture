/**
 * The settings page and the settings model, kept in step.
 *
 * The first build of this page surfaced six of the twenty-one settings the app
 * has. The rest lived only in the view that consumed them, or — in the case of
 * `countIn` — nowhere at all: defined in the defaults, validated on read,
 * written to disk on every save, and never once read by anything.
 *
 * That is a drift problem, not a one-off mistake, so it gets a test rather than
 * a fix. The page's rows are a declarative spec, and this walks the spec
 * against `DEFAULTS` in both directions: every setting has somewhere to be
 * changed, and every row changes something that exists.
 *
 * The spec is read as source rather than imported, because importing the view
 * would drag in `./ui.js` and a DOM. The parse only has to understand the shape
 * this one file writes, and a change to that shape fails loudly here.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS } from '../lib/settings.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const source = (file) => readFileSync(join(ROOT, file), 'utf8')

/**
 * The source with its comments removed.
 *
 * Assertions about what the code does *not* do keep matching the comment that
 * explains why it does not do it — the note above a fix names the thing it
 * replaced, which is exactly the string the test is looking for. Stripping
 * comments first means "this file does not call `window.focus()`" asks about
 * the code and not about the prose.
 */
const code = (file) => source(file)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Every `key: 'name'` inside the SECTIONS block of the settings view. */
function specKeys() {
  const text = source('renderer/view-settings.js')
  const start = text.indexOf('const SECTIONS = [')
  const end = text.indexOf('\n]', start)
  assert.ok(start > 0 && end > start, 'SECTIONS block not found — the spec was restructured')
  const block = text.slice(start, end)
  return new Set([...block.matchAll(/\bkey:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]))
}

describe('the settings page covers the settings', () => {
  /**
   * `theme` and `accent` are in the spec; `captureMode`, `recordSource` and
   * `hotkeys` are deliberately not.
   *
   * The first two are a live choice made in the view that uses them — which
   * display you are shooting is not a preference, it is what you are doing
   * right now — and `hotkeys` has a whole section of its own rather than a row.
   */
  const NOT_ROWS = new Set(['captureMode', 'recordSource', 'hotkeys'])

  test('every stored setting can be changed from the page', () => {
    const rows = specKeys()
    const missing = Object.keys(DEFAULTS).filter((key) => !NOT_ROWS.has(key) && !rows.has(key))
    assert.deepEqual(missing, [],
      `settings with nowhere to change them: ${missing.join(', ')}`)
  })

  test('every row on the page changes a setting that exists', () => {
    const unknown = [...specKeys()].filter((key) => !(key in DEFAULTS))
    assert.deepEqual(unknown, [],
      `rows for settings that are not in DEFAULTS: ${unknown.join(', ')}`)
  })

  test('the ones left out of the spec are left out on purpose', () => {
    // If one of these ever becomes an ordinary preference, this fails and the
    // exclusion has to be argued for again rather than inherited.
    for (const key of NOT_ROWS) {
      assert.ok(key in DEFAULTS, `${key} is excluded from the page but no longer exists`)
    }
  })
})

describe('no setting is dead', () => {
  /**
   * A setting nothing reads is worse than a missing one: it is a control that
   * appears to do something. `countIn` was exactly that for the whole of the
   * first build.
   */
  const CONSUMERS = [
    'main.cjs',
    'renderer/app.js',
    'renderer/ui.js',
    'renderer/view-capture.js',
    'renderer/view-record.js',
    'renderer/view-library.js',
    'renderer/view-settings.js',
    // The auxiliary windows read settings too — the keypress overlay is driven
    // entirely by them, and leaving it out of this list would report five live
    // settings as dead.
    'windows/keys.js',
    'windows/bar.js'
  ]

  test('every setting is read by something other than the settings page', () => {
    const text = CONSUMERS.filter((f) => f !== 'renderer/view-settings.js').map(source).join('\n')
    const spec = source('renderer/view-settings.js')

    const unused = Object.keys(DEFAULTS).filter((key) => {
      // `hotkeys` is read in main; the rest have to appear somewhere that is
      // not the page that only sets them.
      const used = new RegExp(`\\b${key}\\b`).test(text)
      return !used
    })

    assert.deepEqual(unused, [],
      `settings written but never read: ${unused.join(', ')}. ` +
      'A control that changes nothing is worse than a missing one.')
    assert.ok(spec.length > 0)
  })
})

describe('the library empty state', () => {
  /**
   * It used to live inside the right-hand column of the two-column grid, so it
   * centred itself beside a 272px sidebar — which reads as pushed to the right,
   * not as centred.
   */
  test('the whole-library message is outside the two-column grid', () => {
    const text = source('renderer/view-library.js')
    const grid = text.indexOf("el('div.library'")
    const emptyAll = text.indexOf('emptyAll,')
    assert.ok(emptyAll > 0, 'the whole-library empty state should exist')
    assert.ok(emptyAll < grid,
      'the whole-library empty state must be a sibling of the grid, not inside a column of it')
    assert.match(text, /emptyAll = el\('div\.empty\.full'/,
      'it needs the .full modifier, which is what centres it in the view')
  })

  test('an open-but-empty session keeps the sidebar and its own message', () => {
    const text = source('renderer/view-library.js')
    assert.match(text, /emptySession = el\('div\.empty'/)
    // Two states, because a library with nothing in it and a session with
    // nothing in it are different situations with different next actions.
    assert.match(text, /emptySession\.hidden = sum\.steps > 0 \|\| sum\.media > 0/)
  })
})

describe('the title bar', () => {
  test('the status pill is docked, not floating in the middle', () => {
    const css = source('renderer/styles.css')
    const pill = css.slice(css.indexOf('.status-pill {'), css.indexOf('.status-pill .dot'))
    // Absolute centring was honest but read as an element that failed to dock.
    assert.ok(!/position:\s*absolute/.test(pill),
      'the pill should sit in the flow beside the brand')
    assert.match(pill, /margin-left/)
  })
})

describe('closing the app closes the app', () => {
  /**
   * The transport, the keypress overlay and the region overlays are all
   * `BrowserWindow`s, and `window-all-closed` fires only when *all* of them are
   * gone. With any still up, closing the main window left the process running
   * with no window to reach it from — the keypress overlay stayed on screen,
   * and the input hook stayed running: a keylogger with no visible owner and no
   * way to stop it short of the task manager. `will-quit` never fired because
   * the quit never happened.
   */
  const main = () => readFileSync(join(ROOT, 'main.cjs'), 'utf8')

  test('the main window closing tears the auxiliary windows down', () => {
    const text = main()
    const closed = text.slice(text.indexOf("win.on('closed'"), text.indexOf("win.on('closed'") + 700)
    assert.match(closed, /stopHook\(\)/,
      'the input hook must stop when the app window goes')
    for (const aux of ['bar', 'keysWin', 'countWin']) {
      assert.ok(closed.includes(aux), `${aux} must be destroyed with the app window`)
    }
    assert.match(closed, /destroy\(\)/)
  })

  test('the hook still stops on a normal quit as well', () => {
    // Belt and braces: the close handler is the path that actually fires, but a
    // quit from the dock or a signal has to stop it too.
    assert.match(main(), /will-quit[\s\S]{0,200}stopHook\(\)/)
  })
})

describe('a recording gets the app out of the way', () => {
  const record = () => readFileSync(join(ROOT, 'renderer/view-record.js'), 'utf8')

  test('the app minimises before the count, not after', () => {
    const text = record()
    const aside = text.indexOf('app.standAside()')
    const count = text.indexOf('api.count.show(')
    assert.ok(aside > 0 && count > aside,
      'counting before minimising spends the count on the app disappearing')
  })

  test('the count is an overlay, not text in a window that is minimised', () => {
    assert.match(record(), /api\.count\.show\(\{ n, displayId: chosenDisplay\(\) \}\)/)
  })

  test('the transport and the count go on the screen being recorded', () => {
    // Both used to land on the primary display whatever was being recorded, so
    // recording the second monitor put the stop button on the first one.
    const text = record()
    assert.match(text, /displayId: chosenDisplay\(\)/,
      'the transport state has to carry which display the take is of')
    const main = readFileSync(join(ROOT, 'main.cjs'), 'utf8')
    assert.match(main, /placeBar\(window, state\?\.displayId\)/)
    assert.ok(!/screen\.getPrimaryDisplay\(\)\.workArea\b[\s\S]{0,200}BAR\.width/.test(main),
      'the bar must not be pinned to the primary display')
  })

  test('the app comes back when the take ends, and when it fails to start', () => {
    const text = record()
    assert.equal((text.match(/app\.comeBack\(\)/g) || []).length, 2,
      'both the finish path and the failure path have to restore the window')
  })
})

describe('picking a display', () => {
  /**
   * The picker and the capture have to agree on which screen is which.
   *
   * This used to correlate `desktopCapturer.getSources()` with
   * `screen.getAllDisplays()` by *index*, and those two lists have no
   * guaranteed common order. On a single screen it worked by accident; plug in
   * a monitor and picking "Screen 2" captured Screen 1 — which reads as not
   * being able to switch screens at all.
   */
  const capture = () => readFileSync(join(ROOT, 'renderer/view-capture.js'), 'utf8')

  test('the display is read from the source, not inferred from its position', () => {
    const text = capture()
    assert.match(text, /dataset\.displayId/,
      'the tile must carry the display id the source itself reported')
    assert.ok(!/indexOf\(tile\)/.test(text),
      'correlating the two lists by index is the bug this replaced')
  })

  test('main sends a display id with every source', () => {
    assert.match(readFileSync(join(ROOT, 'main.cjs'), 'utf8'), /displayId: s\.display_id/)
  })
})

describe('keys in the recorded video', () => {
  /**
   * The overlay is a real window, so a display recording of the display it is
   * on does contain it — which is why this looked like it worked. A *window*
   * recording captures that window's own content and never anything floating
   * above it, and a display recording of the other monitor has no overlay on it
   * at all. Both are ordinary things to do.
   */
  const record = () => readFileSync(join(ROOT, 'renderer/view-record.js'), 'utf8')

  test('frames go through a compositor when the feature is on', () => {
    const text = record()
    assert.match(text, /settings\.keypress \? composite\(base, settings\.fps\) : base/,
      'the raw stream must be passed straight through when the feature is off')
    assert.match(text, /captureStream\(fps\)/)
  })

  test('the video and the screenshots draw the strip with the same code', () => {
    // Two painters would be two things to keep in step, and they would drift.
    assert.match(record(), /drawCaps\(ctx, state\.keys, state\.settings, canvas\)/)
    assert.match(readFileSync(join(ROOT, 'renderer/ui.js'), 'utf8'),
      /export function drawCaps/)
  })

  test('the compositor is torn down with the recording', () => {
    const text = record()
    assert.match(text, /cleanupComposite\?\.\(\)/,
      'an animation frame loop left running outlives the take it was drawing')
  })
})

describe('the library badge', () => {
  /**
   * It summed `steps` and ignored `media`, so a library holding nothing but
   * recordings — an afternoon of testing the recorder — sat on zero next to a
   * Library tab with four videos in it. The badge is on the word "Library", so
   * it has to mean everything the library holds.
   */
  const app = () => readFileSync(join(ROOT, 'renderer/app.js'), 'utf8')

  test('counts recordings as well as steps', () => {
    const text = app()
    assert.match(text, /s\.steps \|\| 0\) \+ \(s\.media \|\| 0/,
      'the badge must count both kinds of thing the library holds')
    assert.ok(!/reduce\(\(n, s\) => n \+ s\.steps, 0\)/.test(text),
      'summing steps alone is the bug this replaced')
  })

  test('the totals a session reports carry both', () => {
    // `summarise` is what the badge reads, so the shape has to be there.
    const session = readFileSync(join(ROOT, 'lib/session.js'), 'utf8')
    const block = session.slice(session.indexOf('export function summarise'))
    assert.match(block, /steps: session\.steps\.length/)
    assert.match(block, /media: session\.media\.length/)
  })
})

describe('deleting the last thing in a session', () => {
  /**
   * A session emptied by hand is a folder with nothing in it and a row in the
   * library that means nothing. Deleting the only recording in a session and
   * still seeing the session listed is the app disagreeing with what you just
   * did — and `pruneEmpty` in Settings already exists, which is the app
   * agreeing these are litter. Better not to make one.
   */
  const library = () => readFileSync(join(ROOT, 'renderer/view-library.js'), 'utf8')

  test('an emptied session is removed, not left behind', () => {
    const text = library()
    assert.match(text, /async function dropIfEmpty/)
    // Both delete paths have to go through it, or one of them still leaves a
    // stray.
    assert.equal((text.match(/await dropIfEmpty\(\)/g) || []).length, 2,
      'deleting a step and deleting a recording both have to check')
  })

  test('it only fires when the session is actually empty', () => {
    const text = library()
    const fn = text.slice(text.indexOf('async function dropIfEmpty'))
    assert.match(fn, /if \(!sum\.empty\) return false/,
      'a session with anything left in it must survive')
  })

  test('the current-session pointer is cleared and the rail repainted', () => {
    // Clearing `state.session` alone left the sidebar showing the name and step
    // count of a folder that had gone.
    const text = library()
    assert.match(text, /await forgetSession\(gone\)/)
    assert.ok(!/state\.session = null/.test(text),
      'reaching into app state directly skips the repaint that goes with it')

    const app = readFileSync(join(ROOT, 'renderer/app.js'), 'utf8')
    const fn = app.slice(app.indexOf('export async function forgetSession'))
    assert.match(fn, /paintSession\(\)/, 'forgetting a session has to repaint the card')
  })
})

describe('recording while the app is minimised', () => {
  /**
   * These two features were built in the same session and are incompatible by
   * default: the app minimises itself when a take starts, and the keypress
   * compositor drew every frame from `requestAnimationFrame` — which Chromium
   * stops serving to a minimised window. The draw loop died on the first frame,
   * the canvas was never repainted, and `captureStream` produced nothing. The
   * recording ran, saved, and was zero seconds long.
   */
  const record = () => readFileSync(join(ROOT, 'renderer/view-record.js'), 'utf8')

  test('the compositor is driven by a timer, not by animation frames', () => {
    const text = record()
    // The call, not the word — the comment above the fix names it, and should.
    assert.ok(!/requestAnimationFrame\s*\(/.test(text),
      'a minimised window is served no animation frames, and the app minimises itself to record')
    assert.match(text, /setInterval\(draw, Math\.max\(16, Math\.round\(1000 \/ fps\)\)\)/)
  })

  test('the loop is stopped with the take', () => {
    assert.match(record(), /clearInterval\(timer\)/,
      'a timer left running outlives the recording it was drawing')
  })

  test('the window keeps running while it is hidden', () => {
    // Without this a hidden window's timers are clamped to once a second, which
    // turns 30fps into a slideshow even once the loop itself is fixed.
    const main = readFileSync(join(ROOT, 'main.cjs'), 'utf8')
    assert.match(main, /backgroundThrottling: false/)
  })
})

describe('the floating transport fits in its window', () => {
  test('the window is taller than the pill plus its margins', () => {
    const main = readFileSync(join(ROOT, 'main.cjs'), 'utf8')
    const height = Number(/const BAR = \{ width: \d+, height: (\d+) \}/.exec(main)?.[1])
    const bar = readFileSync(join(ROOT, 'windows/bar.html'), 'utf8')
    const pill = Number(/\.pill \{[\s\S]*?height: (\d+)px/.exec(bar)?.[1])

    assert.ok(Number.isFinite(height) && Number.isFinite(pill))
    // It used to be 46 + 5 + 5 = 56 in a 56px window: no slack at all, so a
    // fractional scale factor rounded the bottom edge and its shadow away.
    assert.ok(height - pill >= 16,
      `the window (${height}px) needs room around the pill (${pill}px) for rounding and its shadow`)
  })
})

describe('the overlay windows keep painting', () => {
  /**
   * All four windows need this, and for one reason: every auxiliary window
   * exists precisely for the moments the main one is out of the way. Throttled,
   * their timers clamp to once a second and their animations stall part-way —
   * the transport's entry animation froze at `scale(.95) translateY(10px)`,
   * which measured as a 44px pill sitting 10px low in its window and read as
   * the bar being cropped at the bottom.
   */
  test('every window disables background throttling', () => {
    const main = readFileSync(join(ROOT, 'main.cjs'), 'utf8')
    const windows = (main.match(/new BrowserWindow\(\{/g) || []).length
    const unthrottled = (main.match(/backgroundThrottling: false/g) || []).length
    assert.equal(unthrottled, windows,
      `${windows} windows but only ${unthrottled} keep running while hidden`)
  })
})

describe('windows that cannot be captured', () => {
  /**
   * Some windows Windows Graphics Capture simply refuses — service managers and
   * others with no composited surface, and anything minimised. It logs
   * `Failed to start capture: -2147024809` (E_INVALIDARG) and carries on, so
   * the source still comes back from `getSources`, just with no picture.
   *
   * Offering one in the picker is offering a tile that can only fail, and the
   * failure arrives much later as a message about the window being gone.
   */
  test('a source with no preview is not offered', () => {
    const main = readFileSync(join(ROOT, 'main.cjs'), 'utf8')
    const handler = main.slice(
      main.indexOf("ipcMain.handle('capture:sources'"),
      main.indexOf("ipcMain.handle('region:done'")
    )
    assert.match(handler, /\.filter\(\(s\) => s\.id\.startsWith\('screen'\) \|\| !s\.thumbnail\.isEmpty\(\)\)/,
      'windows with an empty thumbnail must be filtered out of the picker')
  })

  test('displays are exempt from that filter', () => {
    // A screen with a momentarily empty thumbnail is still a screen, and
    // dropping it would leave the picker with nothing in it at all.
    const main = readFileSync(join(ROOT, 'main.cjs'), 'utf8')
    assert.match(main, /s\.id\.startsWith\('screen'\) \|\| !s\.thumbnail\.isEmpty\(\)/)
  })
})

describe('the app does not offer itself as a capture target', () => {
  /**
   * The filter matched on the window title — `/^Rebind Capture$/` — which
   * caught the app window and nothing else. The overlays are titled "Keys",
   * "Starting" and "Recording", so all three were offered as things to record;
   * and the keypress overlay is a full-screen transparent window that sorts
   * first, so the default selection in the window picker was an invisible sheet
   * of glass belonging to the app doing the asking.
   */
  const main = () => readFileSync(join(ROOT, 'main.cjs'), 'utf8')

  test('own windows are excluded by identity, not by title', () => {
    const text = main()
    assert.match(text, /getMediaSourceId\(\)/,
      'the source id is the only reliable way to recognise our own windows')
    assert.ok(!/\/\^Rebind Capture\$\/\.test/.test(text),
      'matching on the title missed every window that is not the main one')
  })

  test('the exclusion covers every window the app opens', () => {
    // Built from `getAllWindows()` rather than a hand-kept list, so a window
    // added later cannot be forgotten.
    assert.match(main(), /BrowserWindow\.getAllWindows\(\)[\s\S]{0,160}getMediaSourceId/)
  })

  test('displays are never excluded by it', () => {
    assert.match(main(), /s\.id\.startsWith\('screen'\) \|\| !own\.has\(s\.id\)/)
  })
})

describe('the keyboard is watched only while it is being recorded', () => {
  /**
   * The hook ran for the whole time the app was open, which is not what
   * "show my keypresses in the recording" asks for and is not something anyone
   * should have to take on trust. It now follows the take by default.
   */
  test('the setting alone is not enough to start the hook', () => {
    const main = readFileSync(join(ROOT, 'main.cjs'), 'utf8')
    assert.match(main, /const wantKeys = \(\) =>\s*\n\s*Boolean\(current\.keypress\) && \(current\.keypressWhen === 'always' \|\| recordingLive\)/,
      'watching has to depend on a take being live, not only on the switch')
  })

  test('the recorder arms it and disarms it', () => {
    const record = readFileSync(join(ROOT, 'renderer/view-record.js'), 'utf8')
    assert.match(record, /api\.keys\.recording\(true\)/, 'a take arms the hook')
    // Both the normal finish and the failed-start path have to disarm, or the
    // hook outlives a recording that never happened.
    assert.equal((record.match(/api\.keys\.recording\(false\)/g) || []).length, 2)
  })

  test('always-on is available but has to be asked for', () => {
    assert.equal(DEFAULTS.keypressWhen, 'recording', 'the safer mode is the default')
    const view = readFileSync(join(ROOT, 'renderer/view-settings.js'), 'utf8')
    assert.match(view, /key: 'keypressWhen'/, 'and the choice is on the settings page')
  })
})

describe('the picker keeps up with what is open', () => {
  test('both pickers watch, and stop watching with the view', () => {
    for (const file of ['renderer/view-capture.js', 'renderer/view-record.js']) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      assert.match(text, /watchSources\(\{/, `${file} should watch its sources`)
      assert.match(text, /watcher\.start\(\)/, `${file} should start the watcher`)
      assert.match(text, /watcher\.prime\(found\)/,
        `${file} should seed the baseline so the first poll is not a false change`)
    }
  })

  test('the recorder does not enumerate mid-take', () => {
    const record = readFileSync(join(ROOT, 'renderer/view-record.js'), 'utf8')
    const watcher = record.slice(record.indexOf('const watcher = watchSources'))
    assert.match(watcher, /if \(state\.phase !== 'ready'\) return/,
      'enumerating during a recording is work taken from the recorder')
  })
})

describe('region capture across displays', () => {
  /**
   * There is one overlay per display and only one window can hold focus, so
   * every overlay calling `window.focus()` on load meant the last to load stole
   * focus from the rest — and a `blur` handler that cancelled on losing focus
   * then tore the whole flow down. On a single screen it worked by accident;
   * with a second monitor attached, region capture cancelled itself the instant
   * it opened and no overlay was ever visible.
   */
  const region = () => code('windows/region.js')
  const main = () => readFileSync(join(ROOT, 'main.cjs'), 'utf8')

  test('an overlay does not cancel the flow by losing focus', () => {
    const text = region()
    assert.ok(!/addEventListener\('blur'/.test(text),
      'only one of N overlays can hold focus, so blur cannot mean "abandoned"')
    assert.ok(!/window\.focus\(\)/.test(text),
      'every overlay grabbing focus is a fight the last one to load wins')
  })

  test('Escape works whichever overlay has focus', () => {
    // The key that abandons an overlay covering every display cannot depend on
    // which window happens to hold focus.
    assert.match(main(), /globalShortcut\.register\('Escape'/)
    assert.match(main(), /globalShortcut\.unregister\('Escape'\)/)
  })

  test('overlays are sized to their display after construction', () => {
    // Electron clamps a new window to what it thinks the screen can hold, so
    // constructor bounds gave a 1920x1080 monitor a 1280x672 overlay — two
    // thirds of the display, with the rest not selectable.
    const text = main()
    const fn = text.slice(text.indexOf('function createRegion'), text.indexOf('function createRegion') + 1400)
    assert.match(fn, /coverDisplay\(overlay, display\)/)
    const bare = code('main.cjs')
    const fnCode = bare.slice(bare.indexOf('function createRegion'), bare.indexOf('function createRegion') + 900)
    assert.ok(!/x: bounds\.x/.test(fnCode), 'constructor bounds are the clamped path')
  })
})

describe('the primary action', () => {
  test('one lit surface, not a two-hue gradient in coloured fog', () => {
    const css = readFileSync(join(ROOT, 'renderer/styles.css'), 'utf8')
    const cta = css.slice(css.indexOf('.cta {'), css.indexOf('.cta:hover'))
    assert.ok(!/linear-gradient\(180deg, var\(--accent-2\), var\(--accent\)\)/.test(cta),
      'a button that changes hue down its height is pretending to be a light source')
    assert.match(cta, /inset 0 1px 0 rgba\(255, 255, 255, \.28\)/,
      'the top-edge highlight is what makes it read as a physical key')
    assert.ok(!/var\(--accent-glow\)/.test(cta),
      'a coloured halo is what made it read as a web hero button')
  })
})

describe('deleting a capture', () => {
  const library = () => code('renderer/view-library.js')

  test('a step has a visible delete, not a hidden gesture', () => {
    const text = library()
    assert.match(text, /el\('button\.shot-del'/,
      'alt-click had nothing on screen to suggest it existed')
    assert.ok(!/event\.altKey/.test(text), 'the gesture is replaced, not merely supplemented')
  })

  test('the tile is not a button, so the delete inside it can be one', () => {
    // A button nested in a button is invalid; browsers hoist it out of the
    // parent and the click stops being reliable.
    const text = library()
    assert.match(text, /el\('div\.shot', \{\s*role: 'button'/)
    assert.match(text, /tabindex: '0'/, 'and it still has to be reachable by keyboard')
  })

  test('the delete does not also toggle the selection behind it', () => {
    assert.match(library(), /event\.stopPropagation\(\)[\s\S]{0,60}removeStep\(step\)/)
  })
})

describe('confirming an irreversible delete', () => {
  /**
   * The session delete used to arm the button in place: one click turned it
   * into "Delete — sure?" and the next did it. The second click lands on the
   * same pixels as the first, so a double-click deleted a session without ever
   * showing the question.
   */
  const library = () => code('renderer/view-library.js')

  test('the arm-in-place button is gone', () => {
    const text = library()
    assert.ok(!/Delete — sure\?/.test(text))
    assert.ok(!/armed/.test(text), 'the armed-state bookkeeping goes with it')
  })

  test('all three deletes ask in a dialog', () => {
    const text = library()
    assert.equal((text.match(/await confirm\(\{/g) || []).length, 3,
      'a step, a recording and a session are each irreversible')
    // And each one has to be able to answer "no".
    assert.equal((text.match(/if \(!ok\) return/g) || []).length, 3)
  })

  test('the dialog says what will actually be lost', () => {
    const text = library()
    assert.match(text, /holds \$\{holds\}, \$\{humanBytes\(sum\.bytes\)\}/,
      'a session delete should name how much is in it')
    assert.match(text, /mmss\(item\.durationMs\)\}\ of video/,
      'a recording delete should name its length')
  })

  test('the safe answer is the one focus starts on', () => {
    // A stray Return on a destructive question must not confirm it.
    const ui = code('renderer/ui.js')
    const fn = ui.slice(ui.indexOf('export function confirm'))
    assert.match(fn, /cancel\.focus\(\)/)
    assert.match(fn, /event\.key === 'Escape'/, 'Escape has to be an answer')
  })
})

/**
 * Naming things.
 *
 * `session.label`, `session.notes` and `step.title` were each defined in the
 * model, written to disk on every save, and read by the exporters — and none of
 * them could be set. `label` was always the empty string `ensureSession` passed
 * it; `notes` was as dead as `countIn` had been; a step's title was the window
 * class the capture came from, printed as the heading of its page.
 *
 * The same drift the settings spec above guards against, in the library. These
 * assert the writing end — that the editors exist and write the field the
 * export reads — and `export.test.mjs` asserts the reading end.
 */
describe('editing the names an export prints', () => {
  const library = () => code('renderer/view-library.js')

  test('each editor writes the field the exporters actually read', () => {
    const text = library()
    assert.match(text, /session\.label = answer/, 'the library list and the output filename')
    assert.match(text, /session\.notes = answer/, 'printed under the heading of a Markdown report')
    assert.match(text, /step\.title = answer \|\| `Step \$\{step\.index\}`/,
      'the heading on a step’s page, and never blank')
  })

  test('all three persist, because the exporters read disk and not the screen', () => {
    const fn = (name) => {
      const text = library()
      const start = text.indexOf(`async function ${name}(`)
      assert.ok(start > 0, `${name} is gone`)
      return text.slice(start, text.indexOf('\n  }', start))
    }
    for (const name of ['renameSession', 'editNotes', 'renameStep']) {
      assert.match(fn(name), /await api\.library\.save\(session\)/, `${name} must save`)
    }
  })

  test('cancelling changes nothing', () => {
    // The dialog resolves null for cancel and '' for a field cleared on
    // purpose, so the guard has to be `=== null` — `if (!answer)` would make
    // "clear this" indistinguishable from "never mind".
    const text = library()
    assert.equal((text.match(/if \(answer === null\) return/g) || []).length, 3)
  })

  test('renaming a session also updates the session the app is using', () => {
    // The rail card and the record view read `state.session.label`; leaving
    // that stale renames the library entry and nothing else on screen.
    assert.match(library(), /state\.session\?\.id === session\.id[\s\S]{0,80}state\.session\.label = answer/)
  })

  test('the rename on a tile does not toggle the selection behind it', () => {
    const text = library()
    assert.match(text, /el\('button\.shot-edit'/, 'a step needs a visible way to be retitled')
    assert.match(text, /event\.stopPropagation\(\)[\s\S]{0,60}renameStep\(step\)/)
  })

  test('the prompt opens with the field focused and the old value selected', () => {
    // A rename box that needs a click before typing, or a select-all before
    // replacing, is a rename box nobody uses twice.
    const ui = code('renderer/ui.js')
    const fn = ui.slice(ui.indexOf('export function promptFor'))
    assert.match(fn, /field\.focus\(\)/)
    assert.match(fn, /if \(!multiline\) field\.select\(\)/)
  })

  test('Escape cancels, and Return only saves where it is not a newline', () => {
    const ui = code('renderer/ui.js')
    const fn = ui.slice(ui.indexOf('export function promptFor'))
    assert.match(fn, /event\.key === 'Escape'[\s\S]{0,60}finish\(null\)/)
    assert.match(fn, /event\.key === 'Enter' && !multiline/,
      'Return in a textarea has to insert a line, not submit the notes')
  })
})
