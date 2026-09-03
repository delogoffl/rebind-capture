/**
 * The whole surface the page is allowed to touch.
 *
 * Nothing is forwarded generically — every call below is a named capability
 * with a fixed shape, so widening what the renderer can do means editing this
 * file and main.cjs together. A generic `invoke(channel, args)` here would undo
 * the entire point of running the renderer sandboxed.
 *
 * The same preload is loaded by all three windows. The main window uses most of
 * it; the region overlay uses `region` and `capture.displays`; the floating bar
 * uses `bar`. Splitting it into three would mean three files that drift.
 */
const { contextBridge, ipcRenderer } = require('electron')

/** Subscriptions return their own unsubscribe, so a caller cannot leak one. */
const on = (channel) => (fn) => {
  const handler = (_event, payload) => fn(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

contextBridge.exposeInMainWorld('capture', {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    /** Get out of the way of a recording, and come back afterwards. */
    standAside: () => ipcRenderer.invoke('app:standAside'),
    comeBack: () => ipcRenderer.invoke('app:comeBack')
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onState: on('window:state')
  },

  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    write: (patch) => ipcRenderer.invoke('settings:write', patch),
    reset: () => ipcRenderer.invoke('settings:reset'),
    onChanged: on('settings:changed')
  },

  shot: {
    screen: (options) => ipcRenderer.invoke('capture:screen', options),
    window: (options) => ipcRenderer.invoke('capture:window', options),
    region: () => ipcRenderer.invoke('capture:region'),
    sources: (types) => ipcRenderer.invoke('capture:sources', types),
    copy: (png) => ipcRenderer.invoke('capture:copy', png),
    /** A hotkey fired somewhere outside the app and produced a capture. */
    onTaken: on('capture:taken'),
    onFailed: on('capture:failed')
  },

  hotkeys: {
    /** Which bindings another application already owns. */
    read: () => ipcRenderer.invoke('hotkeys:read'),
    onState: on('hotkeys:state'),
    onPressed: on('hotkey')
  },

  library: {
    list: () => ipcRenderer.invoke('library:list'),
    read: (id) => ipcRenderer.invoke('library:read', id),
    save: (session) => ipcRenderer.invoke('library:save', session),
    writeAsset: (payload) => ipcRenderer.invoke('library:writeAsset', payload),
    readAsset: (payload) => ipcRenderer.invoke('library:readAsset', payload),
    removeAsset: (payload) => ipcRenderer.invoke('library:removeAsset', payload),
    remove: (id) => ipcRenderer.invoke('library:delete', id),
    renumber: (payload) => ipcRenderer.invoke('library:renumber', payload),
    stats: () => ipcRenderer.invoke('library:stats'),
    prune: () => ipcRenderer.invoke('library:prune'),
    reveal: (id) => ipcRenderer.invoke('library:reveal', id)
  },

  exporter: {
    pick: (payload) => ipcRenderer.invoke('export:pick', payload),
    write: (payload) => ipcRenderer.invoke('export:write', payload)
  },

  bar: {
    show: (state) => ipcRenderer.invoke('bar:show', state),
    update: (state) => ipcRenderer.invoke('bar:update', state),
    hide: () => ipcRenderer.invoke('bar:hide'),
    action: (name) => ipcRenderer.invoke('bar:action', name),
    drag: (delta) => ipcRenderer.invoke('bar:drag', delta),
    onState: on('bar:state'),
    onAction: on('bar:action')
  },

  /**
   * The keypress HUD.
   *
   * `report` is the overlay pushing what it is currently showing up to main, so
   * the capture path can draw the same caps into the image. `onDown` is the raw
   * event going the other way.
   */
  keys: {
    available: () => ipcRenderer.invoke('keys:available'),
    snapshot: () => ipcRenderer.invoke('keys:snapshot'),
    report: (caps) => ipcRenderer.send('keys:report', caps),
    /** A take started or ended — the hook follows it, by default. */
    recording: (live) => ipcRenderer.invoke('keys:recording', live),
    onDown: on('keys:down'),
    onConfig: on('keys:config'),
    onUnavailable: on('keys:unavailable')
  },

  /**
   * The count-in overlay: a number over everything, driven by main.
   *
   * `onTick` is for the overlay window; `show`/`hide` are for the record view
   * that owns the actual waiting.
   */
  count: {
    /** `{ n, displayId }` — which number, and which screen to show it on. */
    show: (payload) => ipcRenderer.invoke('count:show', payload),
    hide: () => ipcRenderer.invoke('count:hide'),
    onTick: on('count:tick')
  },

  region: {
    displays: () => ipcRenderer.invoke('region:displays'),
    done: (result) => ipcRenderer.invoke('region:done', result),
    cancel: () => ipcRenderer.invoke('region:cancel')
  },

  shell: {
    reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
    open: (url) => ipcRenderer.invoke('shell:open', url)
  }
})
