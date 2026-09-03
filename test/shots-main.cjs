/**
 * The Electron half of `test/shots.mjs`.
 *
 * It loads the real `main.cjs` — same windows, same protocol handler, same IPC
 * — and then adds one more `whenReady` handler that drives the UI and captures
 * each view. Nothing about the app knows it is being photographed, which is the
 * point: a screenshot harness that needs hooks in the shipped main process is
 * photographing a slightly different app.
 *
 * Views are reached by clicking the actual rail buttons rather than through a
 * debug global, for the same reason.
 */

const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

require('../main.cjs')

const OUT = process.env.REBIND_SHOTS_OUT
const THEMES = (process.env.REBIND_SHOTS_THEMES || 'dark').split(',')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for the window the real main.cjs creates, rather than guessing at it. */
async function mainWindow() {
  for (let i = 0; i < 80; i++) {
    const [win] = BrowserWindow.getAllWindows()
    if (win && !win.webContents.isLoading()) return win
    await wait(250)
  }
  throw new Error('the main window never finished loading')
}

const run = (win, source) => win.webContents.executeJavaScript(`(() => { ${source} })()`)

async function shoot(win, name) {
  await wait(750)
  const image = await win.webContents.capturePage()
  writeFileSync(join(OUT, `${name}.png`), image.toPNG())
  console.log(`  ${name}`)
}

app.whenReady().then(async () => {
  try {
    mkdirSync(OUT, { recursive: true })
    const win = await mainWindow()
    // The keypress section is mostly disabled rows until the feature is on, and
    // a page of greyed-out controls is not what it looks like in use.
    await win.webContents.executeJavaScript(
      'window.capture.settings.write({ keypress: true })').catch(() => {})
    // The renderer boots asynchronously — settings, the session list and the
    // library stats all have to land before the first view is worth a picture.
    await wait(1800)

    for (const theme of THEMES) {
      // Straight at the attribute: the shot is of the layout, and clicking
      // through the theme control would be three interactions per pass.
      await run(win, `document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)

      await run(win, 'document.querySelector(\'[data-view="capture"]\').click()')
      // The source picker asks main for live thumbnails of every display.
      await wait(1100)
      await shoot(win, `1-capture-${theme}`)

      await run(win, 'document.querySelector(\'[data-view="record"]\').click()')
      await wait(1100)
      await shoot(win, `2-record-${theme}`)

      await run(win, 'document.querySelector(\'[data-view="library"]\').click()')
      await wait(1400)
      await shoot(win, `3-library-${theme}`)

      await run(win, 'document.querySelector(\'[data-view="settings"]\').click()')
      await wait(700)
      await shoot(win, `4-settings-${theme}`)

      // The keypress section, scrolled to. It is most of a screen on its own.
      await run(win, "document.querySelector('#set-keypress').scrollIntoView()")
      await wait(700)
      await shoot(win, `7-keypress-${theme}`)

      await run(win, "document.querySelector('#set-about').scrollIntoView()")
      await wait(600)
      await shoot(win, `8-about-${theme}`)
    }

    // The library with nothing in it, which is its own layout: no session
    // sidebar, and the message centred in the whole view rather than in the
    // column beside a 272px sidebar.
    if (process.env.REBIND_SHOTS_EMPTY) {
      await run(win, "document.querySelector('[data-view=\"library\"]').click()")
      await wait(600)
      // `section.view`, not just the attribute — the rail's nav button carries
      // the same `data-view` and comes first in document order.
      await run(win, `
        const view = document.querySelector('section.view[data-view="library"]')
        view.querySelector('#libraryGrid').hidden = true
        view.querySelector('.empty.full').hidden = false
        view.querySelector('.dock').hidden = true
      `)
      await shoot(win, '6-library-empty-' + THEMES[0])
    }

    // The floating transport, on its own, at the size it actually appears.
    await run(win, 'window.capture.bar.show({ phase: "recording", elapsedMs: 96000, protect: true })')
    await wait(1600)
    // By URL, not by "the other one" — with the keypress overlay up there are
    // three windows open and the transport is not necessarily the second.
    const bar = BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('bar.html'))
    if (bar) {
      const image = await bar.webContents.capturePage()
      writeFileSync(join(OUT, '5-transport.png'), image.toPNG())
      console.log('  5-transport')
    }

    app.exit(0)
  } catch (err) {
    console.error(String(err?.stack || err))
    app.exit(1)
  }
})
