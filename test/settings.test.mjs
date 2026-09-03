/**
 * Settings validation.
 *
 * The premise of every test here is that `settings.json` sits in a folder the
 * user can open, so it *will* be hand-edited, and a hand-edited file must not
 * be able to put the app into a state it cannot start from. The sharpest case
 * is the accelerators: `globalShortcut.register` throws on a malformed string
 * rather than returning false, and a throw during startup is a window that
 * never opens.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, mergeSettings, isAccelerator, conflicts, prettyHotkey } from '../lib/settings.js'

describe('accelerators', () => {
  test('accepts the shapes Electron accepts', () => {
    assert.ok(isAccelerator('CommandOrControl+Shift+1'))
    assert.ok(isAccelerator('Alt+F4'))
    assert.ok(isAccelerator('Ctrl+Shift+PrintScreen'))
    assert.ok(isAccelerator('CmdOrCtrl+Alt+Shift+R'))
    assert.ok(isAccelerator('Super+Space'))
  })

  test('rejects what would throw or silently do nothing', () => {
    // A bare key is not a global shortcut; Electron takes it and the app then
    // swallows that key everywhere on the machine.
    assert.ok(!isAccelerator('R'))
    assert.ok(!isAccelerator(''))
    assert.ok(!isAccelerator(null))
    assert.ok(!isAccelerator('Ctrl+'))
    assert.ok(!isAccelerator('Ctrl+Shift+'))
    assert.ok(!isAccelerator('Nonsense+R'))
    // A duplicated modifier is not a chord anybody can press.
    assert.ok(!isAccelerator('Ctrl+Ctrl+R'))
    assert.ok(!isAccelerator('Ctrl+F25'))
  })

  test('two actions on one chord is reported, because Electron will not', () => {
    const clashes = conflicts({
      captureScreen: 'Ctrl+Shift+1',
      captureWindow: 'Ctrl+Shift+1',
      captureRegion: 'Ctrl+Shift+3'
    })
    assert.equal(clashes.length, 1)
    assert.deepEqual(clashes[0].actions, ['captureScreen', 'captureWindow'])
    assert.equal(conflicts(DEFAULTS.hotkeys).length, 0, 'the defaults must not clash with each other')
  })

  test('reads the way the platform writes it', () => {
    assert.equal(prettyHotkey('CommandOrControl+Shift+1', 'darwin'), '⌘⇧1')
    assert.equal(prettyHotkey('CommandOrControl+Shift+1', 'win32'), 'Ctrl + Shift + 1')
    assert.equal(prettyHotkey('', 'win32'), 'Not set')
  })
})

describe('merging what came off disk', () => {
  test('nothing at all gives the defaults', () => {
    assert.deepEqual(mergeSettings(null), { ...DEFAULTS, hotkeys: { ...DEFAULTS.hotkeys } })
    assert.deepEqual(mergeSettings('garbage'), { ...DEFAULTS, hotkeys: { ...DEFAULTS.hotkeys } })
  })

  test('unknown keys are dropped rather than carried', () => {
    const merged = mergeSettings({ theme: 'light', somethingElse: 'yes' })
    assert.equal(merged.theme, 'light')
    assert.ok(!('somethingElse' in merged))
  })

  test('an out-of-range number is clamped, not taken', () => {
    // A negative countdown would be a capture that never fires; 900 fps is a
    // constraint no device satisfies, so `getUserMedia` fails outright.
    assert.equal(mergeSettings({ countdown: -5 }).countdown, 0)
    assert.equal(mergeSettings({ countdown: 900 }).countdown, 10)
    assert.equal(mergeSettings({ fps: 900 }).fps, 60)
    assert.equal(mergeSettings({ fps: 1 }).fps, 10)
    assert.equal(mergeSettings({ bitrate: 0 }).bitrate, 1)
    assert.equal(mergeSettings({ fps: 'thirty' }).fps, DEFAULTS.fps)
  })

  test('a value outside the enum falls back rather than being honoured', () => {
    assert.equal(mergeSettings({ theme: 'neon' }).theme, DEFAULTS.theme)
    assert.equal(mergeSettings({ captureMode: 'telepathy' }).captureMode, DEFAULTS.captureMode)
    assert.equal(mergeSettings({ accent: 'puce' }).accent, DEFAULTS.accent)
  })

  test('a malformed hotkey falls back and cannot reach globalShortcut', () => {
    const merged = mergeSettings({ hotkeys: { captureScreen: 'Nonsense+++', captureRegion: 'Alt+F7' } })
    assert.equal(merged.hotkeys.captureScreen, DEFAULTS.hotkeys.captureScreen)
    assert.equal(merged.hotkeys.captureRegion, 'Alt+F7')
  })

  test('an explicitly unbound action stays unbound', () => {
    // Empty is a choice — "I do not want a global shortcut for this" — and has
    // to survive a round trip, or the setting silently undoes itself.
    assert.equal(mergeSettings({ hotkeys: { toggleRecording: '' } }).hotkeys.toggleRecording, '')
  })

  test('booleans coerce and strings do not leak into them', () => {
    assert.equal(mergeSettings({ markCursor: 0 }).markCursor, false)
    assert.equal(mergeSettings({ markCursor: 'yes' }).markCursor, true)
    assert.equal(typeof mergeSettings({ sound: 'false' }).sound, 'boolean')
  })

  test('merging is not destructive to the defaults object', () => {
    mergeSettings({ theme: 'light', hotkeys: { captureScreen: 'Alt+F8' } })
    assert.equal(DEFAULTS.theme, 'dark')
    assert.equal(DEFAULTS.hotkeys.captureScreen, 'CommandOrControl+Shift+1')
  })
})
