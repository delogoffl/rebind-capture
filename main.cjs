/**
 * Rebind Capture — main process.
 *
 * Four jobs: own the windows, take the screenshots, hold the global hotkeys,
 * and read and write the library. Everything else happens in the renderer,
 * which runs sandboxed with no Node access — so every capability the page has
 * is one of the `ipcMain.handle` calls below, and if it is not in this file the
 * page cannot do it.
 *
 * Three windows, each of which exists for a reason the others cannot cover:
 *
 *   main       the app. Frameless, custom title bar, does the whole UI.
 *   region     a transparent full-screen overlay for dragging out a rectangle.
 *              Its own window because a click-through overlay has to be able to
 *              sit over every other application, which a page inside the app
 *              window cannot.
 *   bar        the floating recorder transport. Always on top, tiny, and — the
 *              part the browser extension could never manage — excluded from
 *              the recording it controls, via `setContentProtection`.
 *
 * Recording itself is not here. `MediaRecorder` needs a DOM, so the stream is
 * opened and written in the renderer; main only hands over the source id.
 */

const {
  app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut,
  ipcMain, nativeImage, protocol, screen, shell
} = require('electron')
const { existsSync } = require('node:fs')
const { promises: fs } = require('node:fs')
const { join, basename } = require('node:path')
const os = require('node:os')

const ROOT = __dirname

/**
 * Served over a real origin rather than `file://`.
 *
 * The renderer is written as ES modules and imports `../lib/*`; modules are
 * blocked over `file://` by the same-origin rules. A custom scheme also gives
 * the page a stable origin, so `localStorage` and IndexedDB behave across runs.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'capture', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let win = null
let bar = null
let region = null
let keysWin = null
let countWin = null

/**
 * Whether the app minimised itself to get out of the way of a recording.
 *
 * Remembered rather than inferred, so stopping only restores a window that this
 * put away — if the user minimised it themselves mid-take, it stays where they
 * left it.
 */
let minimisedForRecording = false

/**
 * The last state pushed to each auxiliary window.
 *
 * A window is created and told its state in the same breath, but the push
 * arrives before the page has loaded and is dropped — the transport rendered
 * with its HTML defaults, showing 00:00 and no pause button. Keeping the last
 * value and replaying it on `did-finish-load` fixes that without either side
 * having to guess at a delay.
 */
let lastBar = { phase: 'recording', elapsedMs: 0, protect: false }
let lastHotkeys = { failed: [] }

/** Loaded once at startup; `lib/` is ESM and this file is CommonJS. */
let lib = null
const ready = (async () => {
  const [settings, store, session] = await Promise.all([
    import('./lib/settings.js'), import('./lib/store.js'), import('./lib/session.js')
  ])
  lib = { settings, store, session }
})()

/* ────────────────────────────────────────────────────────────────── paths */

const userDir = () => app.getPath('userData')
const libraryRoot = () => join(userDir(), 'library')
const settingsFile = () => join(userDir(), 'settings.json')

let current = { ...{} }

async function loadSettings() {
  await ready
  try {
    return lib.settings.mergeSettings(JSON.parse(await fs.readFile(settingsFile(), 'utf8')))
  } catch {
    return lib.settings.mergeSettings(null)
  }
}

async function saveSettings(next) {
  await ready
  current = lib.settings.mergeSettings(next)
  await lib.store.writeAtomic(settingsFile(), `${JSON.stringify(current, null, 2)}\n`)
  return current
}

function appIcon() {
  // build/ is a build resource and does not ship inside the bundle; packaged,
  // the file sits beside the app in resources.
  const candidates = [join(process.resourcesPath || '', 'icon.png'), join(ROOT, 'build', 'icon.png')]
  const found = candidates.find((file) => existsSync(file))
  return found ? nativeImage.createFromPath(found) : null
}

/* ──────────────────────────────────────────────────────────────── windows */

function createWindow() {
  const icon = appIcon()

  /**
   * Sized against the screen rather than a fixed guess.
   *
   * A hard 1440×920 is larger than a 1366×768 laptop panel at 150% scaling,
   * which reports a work area of about 1280×672 points — so the window would
   * open wider and taller than the desktop it was on. The minimums are clamped
   * for the same reason: a minimum a display cannot satisfy is not a minimum,
   * it is a window the user cannot fit on screen.
   */
  const area = screen.getPrimaryDisplay().workAreaSize
  const fit = (want, available) => Math.max(460, Math.min(want, available - 16))

  win = new BrowserWindow({
    width: fit(1420, area.width),
    height: fit(920, area.height),
    minWidth: fit(1040, area.width),
    minHeight: fit(660, area.height),
    show: false,
    frame: false,
    backgroundColor: '#070A12',
    ...(icon ? { icon } : {}),
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      /**
       * The renderer keeps working while the window is not.
       *
       * The app minimises itself for a recording, and this window is the one
       * holding the `MediaRecorder` and — when the keypress display is on — the
       * canvas compositing every frame. Chromium throttles a hidden window's
       * timers to once a second, which turns a 30fps recording into a slideshow
       * and, before the draw loop was moved off `requestAnimationFrame`, into
       * nothing at all.
       */
      backgroundThrottling: false
    }
  })

  win.once('ready-to-show', () => win?.show())
  win.loadURL('capture://app/renderer/index.html')

  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' })

  const push = () => win?.webContents.send('window:state', {
    maximized: win?.isMaximized() ?? false,
    fullScreen: win?.isFullScreen() ?? false
  })
  win.on('maximize', push)
  win.on('unmaximize', push)
  win.on('enter-full-screen', push)
  win.on('leave-full-screen', push)
  /**
   * Closing the app closes the app.
   *
   * The transport, the keypress overlay and the region overlays are all
   * `BrowserWindow`s, and `window-all-closed` means *all* of them — so with any
   * of those still up, closing the main window left the process running with no
   * window to reach it from. The keypress overlay stayed on screen, and worse,
   * the input hook stayed running: a keylogger with no visible owner and no way
   * to stop it short of the task manager. `will-quit` never fired because the
   * quit never happened.
   *
   * So the auxiliary windows are torn down here rather than being left to an
   * event that cannot arrive while they exist.
   */
  win.on('closed', () => {
    win = null
    stopHook()
    for (const aux of [bar, keysWin, countWin]) {
      if (aux && !aux.isDestroyed()) aux.destroy()
    }
    bar = keysWin = countWin = null
    closeOverlays()
  })
}

/**
 * The floating transport.
 *
 * Small, frameless, always on top, and on every workspace — a recorder control
 * that disappears when the user switches desktop is a recorder control that has
 * to be hunted for.
 *
 * `setContentProtection(true)` is the thing the browser extension could not do.
 * In the extension the bar is DOM inside the recorded tab, so a tab recording
 * necessarily contains it. Here the compositor is told to exclude this window
 * from capture (`WDA_EXCLUDEFROMCAPTURE` on Windows, `NSWindowSharingNone` on
 * macOS), so the controls are on screen for the user and absent from the file.
 * Linux has no equivalent, which is why the setting exists and why the UI says
 * so rather than promising something the platform will not do.
 */
/**
 * Roomier than the pill inside it.
 *
 * The pill is 46px with a 5px margin, which came to exactly the old 56px window
 * — no slack anywhere. At a fractional scale factor the window rounds down by a
 * pixel and the bottom edge of the pill, along with its shadow, is simply cut
 * off. Giving the window a few points more and centring the pill inside means
 * rounding has somewhere to go.
 */
const BAR = { width: 304, height: 72 }

/**
 * The display a recording is of.
 *
 * `display_id` comes back as a string from `desktopCapturer` and as a number
 * from `screen`, and a window source has none at all — in which case the
 * controls belong wherever the pointer is, which is the best available guess at
 * where the user is looking.
 */
function displayById(id) {
  const wanted = Number(id)
  return screen.getAllDisplays().find((d) => d.id === wanted) ||
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

/**
 * Put the transport on the screen being recorded.
 *
 * It used to sit at the bottom of the *primary* display, always. Record the
 * second monitor and the stop button was on the first one — so the controls for
 * the thing you were watching were on a screen you were not.
 *
 * Bottom centre of the work area, so it clears the taskbar rather than sitting
 * under it.
 */
function placeBar(window, displayId) {
  const area = displayById(displayId).workArea
  window.setBounds({
    x: Math.round(area.x + (area.width - BAR.width) / 2),
    y: Math.round(area.y + area.height - BAR.height - 40),
    width: BAR.width,
    height: BAR.height
  })
}

function createBar() {
  if (bar && !bar.isDestroyed()) return bar

  bar = new BrowserWindow({
    width: BAR.width,
    height: BAR.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /**
       * These keep painting while the app is minimised.
       *
       * Every one of them is an always-on-top overlay that exists precisely
       * for the moments the main window is out of the way — the transport's
       * clock, the count-in, the keypress strip. Throttled, their timers are
       * clamped to once a second and their animations stall part-way: the
       * transport's entry animation froze at `scale(.95) translateY(10px)`,
       * which is what made the pill look cropped at the bottom of its window.
       */
      backgroundThrottling: false
    }
  })

  // 'screen-saver' outranks ordinary always-on-top windows, including most
  // full-screen apps — which is exactly the case where losing the stop button
  // matters most.
  bar.setAlwaysOnTop(true, 'screen-saver')
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (current.protectBar !== false) bar.setContentProtection(true)
  bar.loadURL('capture://app/windows/bar.html')
  bar.webContents.on('did-finish-load', () => send(bar, 'bar:state', lastBar))
  bar.on('closed', () => { bar = null })
  return bar
}

/**
 * The count-in.
 *
 * Its own full-screen, click-through, transparent window, for one reason: by
 * the time it counts, the app has minimised itself out of the way, so a number
 * drawn inside the app window would be counting down behind the taskbar. The
 * count has to be over whatever the user is about to record, which means it has
 * to be over everything.
 *
 * Content-protected on the same terms as the transport, so it never lands in
 * the first second of the take it is counting into.
 */
/**
 * Cover a display, now.
 *
 * Sizing at construction does not work: Electron clamps a new window to what it
 * thinks the screen can hold, and a full-screen overlay asked for at 1920×1080
 * came back 1280×672 — the count then drew centred in a rectangle two thirds of
 * the screen, which is not the middle of anything.
 *
 * Doing it on every show fixes the second half of the same problem too. These
 * windows outlive one use, and the display the user is working on is not
 * necessarily the one they were on last time.
 */
function coverDisplay(window, display) {
  const target = display || screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  window.setBounds(target.bounds)
  return target
}

function createCountWindow() {
  if (countWin && !countWin.isDestroyed()) return countWin

  countWin = new BrowserWindow({
    width: 800,
    height: 600,
    // Without this the bounds set below are clamped to the primary display, and
    // an overlay for a secondary monitor comes back the wrong size.
    enableLargerThanScreen: true,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /**
       * These keep painting while the app is minimised.
       *
       * Every one of them is an always-on-top overlay that exists precisely
       * for the moments the main window is out of the way — the transport's
       * clock, the count-in, the keypress strip. Throttled, their timers are
       * clamped to once a second and their animations stall part-way: the
       * transport's entry animation froze at `scale(.95) translateY(10px)`,
       * which is what made the pill look cropped at the bottom of its window.
       */
      backgroundThrottling: false
    }
  })

  countWin.setIgnoreMouseEvents(true, { forward: false })
  countWin.setAlwaysOnTop(true, 'screen-saver')
  countWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (process.platform !== 'linux') countWin.setContentProtection(true)
  countWin.loadURL('capture://app/windows/countdown.html')
  countWin.on('closed', () => { countWin = null })
  return countWin
}

/**
 * The region overlay.
 *
 * One window per display, sized to that display, so a drag can start on one
 * monitor and the rectangle is reported in that display's coordinates. A single
 * window spanning the whole virtual desktop is simpler and wrong: the union of
 * two differently-scaled displays is not a rectangle either of them can render
 * a crisp overlay on.
 */
function createRegion(display) {
  const bounds = display.bounds
  const overlay = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /**
       * These keep painting while the app is minimised.
       *
       * Every one of them is an always-on-top overlay that exists precisely
       * for the moments the main window is out of the way — the transport's
       * clock, the count-in, the keypress strip. Throttled, their timers are
       * clamped to once a second and their animations stall part-way: the
       * transport's entry animation froze at `scale(.95) translateY(10px)`,
       * which is what made the pill look cropped at the bottom of its window.
       */
      backgroundThrottling: false
    }
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlay.loadURL(`capture://app/windows/region.html?display=${display.id}`)
  return overlay
}

/* ══════════════════════════════════════════════════════════ the keypress HUD */

/**
 * Watching the keyboard, everywhere.
 *
 * `uiohook-napi` is a real native module and the only way to see keystrokes
 * that are not addressed to this app — Electron has no API for it, by design.
 * It is loaded lazily and behind a try, because "the input hook did not load"
 * has to degrade to "the HUD is unavailable" rather than to "the app will not
 * start": prebuilds cover seven platform triples but not every one, and on
 * macOS the OS can refuse until Accessibility is granted.
 *
 * The hook is only running while the setting is on. A capture tool that watches
 * every keystroke for the whole session whether or not it is drawing them is
 * not something anyone should have to take on trust, and the switch is the
 * thing that makes that claim checkable.
 */
let hook = null
let hookRunning = false
let hookError = null

/**
 * The strip as the overlay last drew it.
 *
 * The overlay owns the folding and the expiry, so it is the only thing that
 * knows what is currently on screen — and the capture path needs exactly that,
 * at the instant the shutter fires, to draw into the image. It reports up
 * rather than being asked, because being asked would race the hide.
 */
let keysSnapshot = []

function loadHook() {
  if (hook || hookError) return hook
  try {
    hook = require('uiohook-napi')
  } catch (err) {
    hookError = String(err?.message || err)
  }
  return hook
}

async function startHook() {
  await ready
  const api = loadHook()
  if (!api) return false
  if (hookRunning) return true
  try {
    api.uIOhook.on('keydown', onGlobalKey)
    api.uIOhook.start()
    hookRunning = true
  } catch (err) {
    hookError = String(err?.message || err)
    return false
  }
  return true
}

function stopHook() {
  if (!hookRunning || !hook) return
  try {
    hook.uIOhook.off('keydown', onGlobalKey)
    hook.uIOhook.stop()
  } catch { /* already gone */ }
  hookRunning = false
}

/**
 * A key was pressed somewhere on the machine.
 *
 * Forwarded raw. Everything about what it is called, whether it masks and how
 * it folds into the strip lives in `lib/keys.js`, which is pure and tested; the
 * main process's only job is to be the thing that can see the event at all.
 */
function onGlobalKey(event) {
  if (!current.keypress) return
  send(keysWin, 'keys:down', {
    keycode: event.keycode,
    shiftKey: Boolean(event.shiftKey),
    altKey: Boolean(event.altKey),
    ctrlKey: Boolean(event.ctrlKey),
    metaKey: Boolean(event.metaKey),
    at: Date.now()
  })
  // The app's own window draws the settings preview from the same events, so
  // what you configure is what you are watching.
  send(win, 'keys:down', { keycode: event.keycode, at: Date.now() })
}

/**
 * The overlay: transparent, click-through, on top of everything.
 *
 * `setIgnoreMouseEvents` is what makes it an overlay rather than a window in
 * the way — without it a full-screen transparent window swallows every click on
 * the desktop, which is a spectacular way to make a machine unusable.
 */
function createKeysWindow() {
  if (keysWin && !keysWin.isDestroyed()) return keysWin

  keysWin = new BrowserWindow({
    width: 800,
    height: 600,
    enableLargerThanScreen: true,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /**
       * These keep painting while the app is minimised.
       *
       * Every one of them is an always-on-top overlay that exists precisely
       * for the moments the main window is out of the way — the transport's
       * clock, the count-in, the keypress strip. Throttled, their timers are
       * clamped to once a second and their animations stall part-way: the
       * transport's entry animation froze at `scale(.95) translateY(10px)`,
       * which is what made the pill look cropped at the bottom of its window.
       */
      backgroundThrottling: false
    }
  })

  keysWin.setIgnoreMouseEvents(true, { forward: false })
  keysWin.setAlwaysOnTop(true, 'screen-saver')
  keysWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  keysWin.loadURL('capture://app/windows/keys.html')
  keysWin.webContents.on('did-finish-load', () => send(keysWin, 'keys:config', current))
  keysWin.on('closed', () => { keysWin = null })
  return keysWin
}

/**
 * Turn the whole feature on or off together.
 *
 * The hook and the window are one switch: a running hook with no window is a
 * keylogger, and a window with no hook is an empty rectangle on top of
 * everything.
 */
async function syncKeypress() {
  if (current.keypress) {
    const ok = await startHook()
    if (!ok) {
      // The setting cannot stay on if the thing it needs did not load, or the
      // switch is claiming something untrue.
      current = await saveSettings({ ...current, keypress: false })
      send(win, 'settings:changed', current)
      send(win, 'keys:unavailable', { reason: hookError || 'The input hook is unavailable.' })
      return
    }
    const window = createKeysWindow()
    coverDisplay(window)
    window.showInactive()
    window.setAlwaysOnTop(true, 'screen-saver')
    send(window, 'keys:config', current)
  } else {
    stopHook()
    if (keysWin && !keysWin.isDestroyed()) keysWin.hide()
  }
}

/* ─────────────────────────────────────────────────────────────── capturing */

/**
 * A full-resolution frame of a display or a window.
 *
 * `desktopCapturer` is the only screenshot API Electron exposes, and its
 * `thumbnail` is whatever size was asked for — so asking for the display's own
 * pixel size gets a real capture rather than a thumbnail. The size has to be in
 * *physical* pixels, `size` × `scaleFactor`, or a 200% display comes back at
 * half resolution and every export is soft.
 */
async function grabSources(types, display) {
  const scale = display ? display.scaleFactor : screen.getPrimaryDisplay().scaleFactor
  const bounds = display ? display.size : screen.getPrimaryDisplay().size
  return desktopCapturer.getSources({
    types,
    thumbnailSize: {
      width: Math.round(bounds.width * scale),
      height: Math.round(bounds.height * scale)
    },
    // Only the picker needs icons. Asking for them here means fetching an icon
    // for every window on the system on the way to capturing one of them.
    fetchWindowIcons: false
  })
}

/** Which display a source belongs to, so the cursor can be placed on it. */
function displayForSource(source) {
  const id = Number(source.display_id)
  const all = screen.getAllDisplays()
  return all.find((d) => d.id === id) || screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

/**
 * Take the app out of the shot.
 *
 * Hiding rather than lowering: an app window merely sent to the back is still
 * composited, and on Windows a capture can still pick up its shadow along the
 * edge. The wait is for the compositor to actually repaint — without it the
 * capture is quick enough to catch the window still on screen.
 */
async function withHidden(run) {
  const hide = current.hideOnCapture !== false && win && win.isVisible() && !win.isMinimized()
  // The keypress HUD comes off screen for the shot whatever `hideOnCapture`
  // says, because it is drawn back into the image afterwards. Leaving it up
  // would put it in the picture twice, at two different scales.
  const hideKeys = keysWin && !keysWin.isDestroyed() && keysWin.isVisible()

  if (hideKeys) keysWin.hide()
  if (hide) win.hide()
  if (hide || hideKeys) await wait(220)

  try {
    return await run()
  } finally {
    if (hideKeys && current.keypress) keysWin.showInactive()
    if (hide) {
      win.showInactive()
      // Focus is deliberately not taken back: the user was looking at whatever
      // they captured, and yanking focus is how a capture tool loses the state
      // the next capture was meant to record.
    }
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function captureScreen({ displayId, mode = 'screen' } = {}) {
  await ready
  const display = displayId
    ? screen.getAllDisplays().find((d) => d.id === displayId)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())

  return withHidden(async () => {
    if (current.countdown > 0) await wait(current.countdown * 1000);
    const cursor = screen.getCursorScreenPoint()
    const sources = await grabSources(['screen'], display)
    const match = sources.find((s) => Number(s.display_id) === display.id) || sources[0]
    if (!match) throw new Error('No display could be captured.')

    const image = match.thumbnail
    const size = image.getSize()
    const scale = size.width / display.size.width || display.scaleFactor

    return {
      mode,
      png: image.toPNG(),
      width: size.width,
      height: size.height,
      // In image pixels, not screen points: an annotator drawing on the PNG
      // works in the PNG's coordinate system.
      cursor: {
        x: Math.round((cursor.x - display.bounds.x) * scale),
        y: Math.round((cursor.y - display.bounds.y) * scale)
      },
      source: { kind: 'screen', id: match.id, name: match.name || `Display ${display.id}`, displayId: display.id },
      meta: machineInfo(display)
    }
  })
}

/**
 * Find a window source, with one retry.
 *
 * Windows Graphics Capture fails with `E_INVALIDARG` for windows it cannot
 * photograph — most often one that is minimised, and sometimes one that is
 * mid-resize or has just closed. Chromium logs that per window and carries on,
 * so the enumeration comes back missing entries rather than throwing, and the
 * only symptom here was the chosen id not being in the list.
 *
 * Those failures are frequently momentary, so it is worth asking twice before
 * telling the user their window is gone.
 */
async function findWindowSource(sourceId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sources = await grabSources(['window'])
    const match = sourceId ? sources.find((s) => s.id === sourceId) : sources[0]
    // An entry with an empty thumbnail is a window WGC declined to capture; it
    // is no more use than a missing one, so it counts as a miss and is retried.
    if (match && !match.thumbnail.isEmpty()) return match
    if (attempt === 0) await wait(250)
  }
  return null
}

async function captureWindow({ sourceId } = {}) {
  await ready
  return withHidden(async () => {
    if (current.countdown > 0) await wait(current.countdown * 1000)
    const match = await findWindowSource(sourceId)
    if (!match) {
      // Named causes, because "no longer open" was wrong most of the time — the
      // window is usually still there and merely minimised, which Windows
      // Graphics Capture cannot photograph at all.
      throw new Error('That window could not be captured. If it is minimised, restore it first — a minimised window has nothing to photograph.')
    }

    const image = match.thumbnail
    const size = image.getSize()
    if (!size.width || !size.height) throw new Error('That window could not be captured.')

    return {
      mode: 'window',
      png: image.toPNG(),
      width: size.width,
      height: size.height,
      cursor: null,
      source: { kind: 'window', id: match.id, name: match.name || 'Window' },
      meta: machineInfo(displayForSource(match))
    }
  })
}

/**
 * A rectangle of a display.
 *
 * The whole display is captured and then cropped, rather than asking for a
 * sub-rectangle, because `desktopCapturer` has no sub-rectangle. The crop runs
 * through `nativeImage`, which is native code — a JS crop of a 4K frame in the
 * main process would block the event loop long enough to be visible.
 */
async function captureRegion({ displayId, rect }) {
  await ready
  const display = screen.getAllDisplays().find((d) => d.id === displayId) ||
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint())

  const sources = await grabSources(['screen'], display)
  const match = sources.find((s) => Number(s.display_id) === display.id) || sources[0]
  if (!match) throw new Error('No display could be captured.')

  const full = match.thumbnail
  const size = full.getSize()
  const scale = size.width / display.size.width || display.scaleFactor

  const crop = {
    x: Math.max(0, Math.round(rect.x * scale)),
    y: Math.max(0, Math.round(rect.y * scale)),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale)
  }
  crop.width = Math.max(1, Math.min(crop.width, size.width - crop.x))
  crop.height = Math.max(1, Math.min(crop.height, size.height - crop.y))

  const image = full.crop(crop)
  const out = image.getSize()

  return {
    mode: 'region',
    png: image.toPNG(),
    width: out.width,
    height: out.height,
    cursor: null,
    source: { kind: 'region', id: match.id, name: `${out.width}×${out.height} region`, displayId: display.id },
    meta: machineInfo(display)
  }
}

function machineInfo(display) {
  const d = display || screen.getPrimaryDisplay()
  return {
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    display: `${d.size.width}×${d.size.height}`,
    scale: d.scaleFactor,
    at: new Date().toISOString()
  }
}

/* ───────────────────────────────────────────────────────────────── hotkeys */

/**
 * Bind the global shortcuts, and report what could not be bound.
 *
 * `globalShortcut.register` returns false when another application already owns
 * the chord — which is common, and silent. The failures come back so the
 * settings panel can mark that row rather than leaving the user pressing a key
 * that belongs to something else.
 */
function bindHotkeys() {
  globalShortcut.unregisterAll()
  const failed = []
  const actions = {
    captureScreen: () => runCapture('screen'),
    captureWindow: () => runCapture('window'),
    captureRegion: () => runCapture('region'),
    toggleRecording: () => send(win, 'hotkey', { action: 'toggleRecording' }),
    pauseRecording: () => send(win, 'hotkey', { action: 'pauseRecording' })
  }

  for (const [action, combo] of Object.entries(current.hotkeys || {})) {
    if (!combo || !lib.settings.isAccelerator(combo)) continue
    try {
      if (!globalShortcut.register(combo, actions[action])) failed.push({ action, combo })
    } catch {
      failed.push({ action, combo })
    }
  }
  lastHotkeys = { failed }
  send(win, 'hotkeys:state', lastHotkeys)
  return failed
}

/**
 * A hotkey capture goes straight to the renderer to be stored.
 *
 * Main takes the picture but does not own the library — one writer keeps the
 * session index and the files in step, and that writer is the renderer, which
 * is also the only place that can make the thumbnail.
 */
async function runCapture(mode) {
  try {
    const shot = mode === 'region'
      ? await beginRegion()
      : mode === 'window'
        ? await captureWindow({})
        : await captureScreen({})
    if (!shot) return
    if (current.copyToClipboard) clipboard.writeImage(nativeImage.createFromBuffer(shot.png))
    send(win, 'capture:taken', serialisable(shot))
  } catch (err) {
    send(win, 'capture:failed', { message: String(err?.message || err) })
  }
}

/** A Buffer survives IPC as a Uint8Array; nothing else here needs converting. */
const serialisable = (shot) => ({ ...shot, png: new Uint8Array(shot.png) })

/* ──────────────────────────────────────────────────────────── region flow */

let regionPending = null

/**
 * Show an overlay on every display and wait for one of them to answer.
 *
 * All the overlays close on the first answer — or on Escape from any of them —
 * so a cancel on one monitor does not leave three dimmed screens behind. The
 * promise is stored rather than passed around because the answer arrives on an
 * IPC channel, which has no memory of who asked.
 */
function beginRegion() {
  if (regionPending) return regionPending.promise

  const overlays = screen.getAllDisplays().map((display) => createRegion(display))
  region = overlays

  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  regionPending = { promise, resolve: settle }

  for (const overlay of overlays) {
    overlay.once('ready-to-show', () => overlay.show())
    overlay.on('closed', () => {
      // Every overlay gone with no answer is a cancel, however it happened.
      if (regionPending && overlays.every((o) => o.isDestroyed())) finishRegion(null)
    })
  }
  return promise
}

function closeOverlays() {
  for (const overlay of region || []) {
    if (!overlay.isDestroyed()) overlay.close()
  }
  region = null
}

async function finishRegion(result) {
  const pending = regionPending
  regionPending = null
  closeOverlays()
  if (!pending) return
  if (!result) { pending.resolve(null); return }
  try {
    // A beat for the overlays to actually leave the compositor, or the dimming
    // is in the picture.
    await wait(120)
    pending.resolve(await captureRegion(result))
  } catch (err) {
    send(win, 'capture:failed', { message: String(err?.message || err) })
    pending.resolve(null)
  }
}

/* ─────────────────────────────────────────────────────────────────── ipc */

const send = (target, channel, payload) => {
  if (target && !target.isDestroyed()) target.webContents.send(channel, payload)
}

function handlers() {
  ipcMain.handle('window:minimize', () => win?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', () => win?.close())
  ipcMain.handle('window:isMaximized', () => win?.isMaximized() ?? false)

  ipcMain.handle('app:info', async () => {
    await ready
    return {
      version: app.getVersion(),
      name: app.getName(),
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      libraryPath: libraryRoot(),
      settingsPath: settingsFile(),
      /** Linux has no compositor-level capture exclusion; the UI has to say so. */
      canProtect: process.platform !== 'linux'
    }
  })

  // Pullable, because the renderer subscribes several async hops into its own
  // boot and would otherwise miss the push that happened at startup.
  ipcMain.handle('hotkeys:read', async () => lastHotkeys)

  ipcMain.handle('settings:read', async () => current)
  ipcMain.handle('settings:write', async (_e, patch) => {
    const was = current.keypress
    const next = await saveSettings({ ...current, ...patch, hotkeys: { ...current.hotkeys, ...(patch?.hotkeys || {}) } })
    bindHotkeys()
    if (bar && !bar.isDestroyed()) bar.setContentProtection(next.protectBar !== false)
    // Turning it on or off starts and stops the hook; anything else just
    // restyles a HUD that is already up.
    if (next.keypress !== was) await syncKeypress()
    else send(keysWin, 'keys:config', next)
    send(win, 'settings:changed', next)
    return next
  })
  ipcMain.handle('settings:reset', async () => {
    const next = await saveSettings(null)
    bindHotkeys()
    return next
  })

  ipcMain.handle('capture:screen', (_e, options) => captureScreen(options).then(serialisable))
  ipcMain.handle('capture:window', (_e, options) => captureWindow(options).then(serialisable))
  ipcMain.handle('capture:region', async () => {
    const shot = await beginRegion()
    return shot ? serialisable(shot) : null
  })
  ipcMain.handle('capture:copy', (_e, png) => {
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png)))
    return true
  })

  /** The picker's list: windows and displays, with a small preview of each. */
  ipcMain.handle('capture:sources', async (_e, types = ['screen', 'window']) => {
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 360, height: 240 },
      fetchWindowIcons: true
    })
    return sources
      // Our own overlays and the transport are not things anyone means to record.
      .filter((s) => !/^Rebind Capture$/.test(s.name) || s.id.startsWith('screen'))
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen') ? 'screen' : 'window',
        displayId: s.display_id ? Number(s.display_id) : null,
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
      }))
  })

  /**
   * Whether the hook can run here.
   *
   * Probed rather than assumed: a prebuild may be missing for this triple, and
   * on macOS the OS refuses until Accessibility is granted. The settings panel
   * needs a real answer so it can explain itself rather than offering a switch
   * that silently does nothing.
   */
  ipcMain.handle('keys:available', async () => {
    loadHook()
    return { available: Boolean(hook), running: hookRunning, reason: hookError }
  })

  /** What is on the strip right now, for burning into a capture. */
  ipcMain.handle('keys:snapshot', async () => keysSnapshot)
  ipcMain.on('keys:report', (_e, caps) => { keysSnapshot = caps })

  ipcMain.handle('region:done', (_e, result) => finishRegion(result))
  ipcMain.handle('region:cancel', () => finishRegion(null))
  ipcMain.handle('region:displays', () => screen.getAllDisplays().map((d) => ({
    id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor
  })))

  /* ── the library ── */

  ipcMain.handle('library:list', async () => {
    await ready
    return lib.store.listSessions(libraryRoot())
  })
  ipcMain.handle('library:read', async (_e, id) => {
    await ready
    return lib.store.loadSession(libraryRoot(), id)
  })
  ipcMain.handle('library:save', async (_e, session) => {
    await ready
    return lib.store.saveSession(libraryRoot(), session)
  })
  ipcMain.handle('library:writeAsset', async (_e, { sessionId, name, data }) => {
    await ready
    return lib.store.writeAsset(libraryRoot(), sessionId, name, Buffer.from(data))
  })
  ipcMain.handle('library:readAsset', async (_e, { sessionId, name }) => {
    await ready
    const buffer = await lib.store.readAsset(libraryRoot(), sessionId, name)
    return new Uint8Array(buffer)
  })
  ipcMain.handle('library:removeAsset', async (_e, { sessionId, name }) => {
    await ready
    return lib.store.removeAsset(libraryRoot(), sessionId, name)
  })
  ipcMain.handle('library:delete', async (_e, id) => {
    await ready
    return lib.store.deleteSession(libraryRoot(), id)
  })
  ipcMain.handle('library:renumber', async (_e, { sessionId, renames }) => {
    await ready
    return lib.store.applyRenames(libraryRoot(), sessionId, renames)
  })
  ipcMain.handle('library:stats', async () => {
    await ready
    return { bytes: await lib.store.libraryBytes(libraryRoot()), path: libraryRoot() }
  })
  ipcMain.handle('library:prune', async () => {
    await ready
    return lib.store.pruneEmpty(libraryRoot())
  })
  ipcMain.handle('library:reveal', async (_e, id) => {
    await ready
    const dir = id ? lib.store.sessionDir(libraryRoot(), id) : libraryRoot()
    await lib.store.ensureDir(dir)
    shell.openPath(dir)
    return dir
  })

  /* ── writing exports out ── */

  ipcMain.handle('export:pick', async (_e, { name, kind }) => {
    if (kind === 'folder') {
      const picked = await dialog.showOpenDialog(win, {
        title: 'Choose a folder for the export',
        properties: ['openDirectory', 'createDirectory']
      })
      return picked.canceled ? null : picked.filePaths[0]
    }
    const picked = await dialog.showSaveDialog(win, { title: 'Save export', defaultPath: name })
    return picked.canceled ? null : picked.filePath
  })

  ipcMain.handle('export:write', async (_e, { path, files }) => {
    await ready
    const written = []
    for (const file of files) {
      // One file goes exactly where the user pointed; several go into the
      // folder they chose, keeping the names the export decided on.
      const target = files.length === 1 && !path.endsWith('/') && basename(path).includes('.')
        ? path
        : join(path, file.name)
      await lib.store.writeAtomic(target, Buffer.from(file.data))
      written.push(target)
    }
    return written
  })

  ipcMain.handle('shell:reveal', (_e, path) => { shell.showItemInFolder(path); return true })
  ipcMain.handle('shell:open', (_e, target) => shell.openExternal(target))

  /* ── the floating transport ── */

  ipcMain.handle('bar:show', (_e, state) => {
    lastBar = { ...lastBar, ...state }
    const window = createBar()
    // Positioned on every show, because which screen is being recorded is not
    // known when the window is created and can differ between takes.
    placeBar(window, state?.displayId)
    window.showInactive()
    // Re-asserted on every show. A window created while the app had focus can
    // end up below whatever the user switches to next, and the whole point of
    // this one is that it is reachable from inside the thing being recorded.
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Sent now for a window that is already up, and again on load for one that
    // is not — whichever arrives second is the same value.
    send(window, 'bar:state', lastBar)
    return true
  })

  /* ── getting out of the way ── */

  /**
   * Minimise for a recording, and put it back afterwards.
   *
   * A recorder whose own window is still covering the thing you wanted to
   * record is not much of a recorder. The transport stays — that is what it is
   * for — and it is a separate always-on-top window, so minimising the app does
   * not take it down with it.
   */
  ipcMain.handle('app:standAside', async () => {
    if (!win || win.isDestroyed() || !current.minimizeOnRecord) return false
    if (win.isMinimized()) return false
    win.minimize()
    minimisedForRecording = true
    // A beat for the compositor, or the first frame of the take still has the
    // app window sliding off it.
    await wait(320)
    return true
  })

  ipcMain.handle('app:comeBack', () => {
    if (!minimisedForRecording) return false
    minimisedForRecording = false
    if (!win || win.isDestroyed()) return false
    // Restored, not focused-and-raised over whatever the user moved on to.
    win.restore()
    return true
  })

  /* ── the count-in ── */

  ipcMain.handle('count:show', (_e, payload) => {
    const { n, displayId } = typeof payload === 'object' ? payload : { n: payload }
    const window = createCountWindow()
    // Over the display about to be recorded, for the same reason as the
    // transport: counting a user in on a screen they are not watching is not
    // counting them in.
    coverDisplay(window, displayId ? displayById(displayId) : null)
    window.showInactive()
    window.setAlwaysOnTop(true, 'screen-saver')
    send(window, 'count:tick', { n })
    return true
  })

  ipcMain.handle('count:hide', () => {
    if (countWin && !countWin.isDestroyed()) countWin.hide()
    return true
  })
  ipcMain.handle('bar:update', (_e, state) => {
    lastBar = { ...lastBar, ...state }
    send(bar, 'bar:state', lastBar)
    return true
  })
  ipcMain.handle('bar:hide', () => {
    if (bar && !bar.isDestroyed()) bar.hide()
    return true
  })
  /** The bar's buttons are the only thing it does; they all land here. */
  ipcMain.handle('bar:action', (_e, action) => { send(win, 'bar:action', action); return true })
  ipcMain.handle('bar:drag', (_e, { dx, dy }) => {
    if (!bar || bar.isDestroyed()) return false
    const [x, y] = bar.getPosition()
    bar.setPosition(Math.round(x + dx), Math.round(y + dy))
    return true
  })
}

/* ────────────────────────────────────────────────────────────────── boot */

// One instance. A second launch of a capture tool would fight the first for
// the global hotkeys, and the loser is silent about it.
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(async () => {
    await ready

    /**
     * Serve the app directory over the custom scheme.
     *
     * Paths are resolved against ROOT and then checked to still be inside it —
     * `capture://app/../../etc/passwd` is a request the page can make, and a
     * handler that only concatenates would answer it.
     */
    protocol.handle('capture', async (request) => {
      const url = new URL(request.url)
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const file = join(ROOT, rel)
      if (!file.startsWith(ROOT)) return new Response('Forbidden', { status: 403 })
      try {
        const data = await fs.readFile(file)
        return new Response(data, { headers: { 'content-type': mime(file) } })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })

    current = await loadSettings()
    await lib.store.ensureDir(libraryRoot())
    handlers()
    createWindow()
    bindHotkeys()
    // Restore it if it was left on, so the setting survives a restart.
    if (current.keypress) syncKeypress()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    // A native hook that outlives the process is the one failure mode worth
    // being careful about here.
    stopHook()
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
}

function mime(file) {
  const dot = file.lastIndexOf('.')
  return MIME[file.slice(dot).toLowerCase()] || 'application/octet-stream'
}
