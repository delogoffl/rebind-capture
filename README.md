# Rebind Capture

**Desktop step capture and screen recording.** Take numbered, timestamped shots
of any display, window or rectangle; record a display or a single window with
audio; and export the run as a PDF, the raw PNGs, a Markdown report, or the
video files.

The desktop sibling of the [ScreenStep browser extension](../rebind-screenstep),
and it goes where a browser extension cannot: any application, not just a tab.

Two devDependencies — `electron` and `electron-builder` — and exactly one
runtime dependency: `uiohook-napi`, the global input hook the keypress display
needs. Nothing else is pulled in; the PDF writer, the ZIP writer and the PNG
codec are all in this repository.

```
npm start              run it
npm run dev            run it with devtools
npm run icons          re-derive the app icons from icon/iconmain.png
npm test               318 tests, plain Node, no Electron needed
npm run probe          drive the real app in Electron: annotate, hash, extract, play
npm run probe:seek     measure how each container survives being seeked
npm run shots          screenshot every view, both themes, into shots/
npm run dist           package installers for this platform
```

---

## What it does

- **Capture** — a whole display, a single window, or a rectangle you drag out.
  A live thumbnail of every source, because "which window?" answered with a list
  of process names is a question most people cannot answer. Optional countdown,
  so a menu can be opened first, and the app hides itself before the shutter so
  it is never in its own screenshot.
- **Global shortcuts** — capture from anywhere on the machine, with this window
  closed. Bound by pressing the keys, not by typing an accelerator string.
- **Record** — a display or one window, at a frame rate and bitrate you choose,
  with system audio and narration mixed into the same file. MP4 where the engine
  supports it, WebM otherwise, negotiated rather than assumed — and the codec
  string is chosen from what the stream actually holds. Naming an audio codec
  for a silent recording produces a file at half the byte count that reports
  seek positions it cannot honour, which is measured in `npm run probe:seek`.
- **The floating transport** — elapsed time, pause, resume and stop, always on
  top and on every workspace, and **excluded from the recording it controls**.
- **Library** — one folder per session on disk, with a readable index beside the
  images. Steps and recordings are selected separately, and each recording has
  its own one-click save. A finished recording lands here, on the take it just
  made, rather than back on the screen for setting one up.
- **The player** — its own chrome rather than the browser's, because the
  browser's cannot say anything about what it is playing. The clicks and
  keystrokes a recording captured are drawn as ticks along the scrubber, so the
  timeline is a map of the take: dense where the work was, empty where you were
  reading. Clicking a tick jumps to that action, and the same plan that draws
  them is the one that cuts the steps.
- **Export** — PDF (one step per page, hand-written writer), PNG (one file or a
  zip), Markdown (a report plus the images, with YAML front matter), and the
  recordings.
- **Keypress display** — a strip of keycaps on screen while you work, drawn
  *into* every capture you take. Six corners, four sizes, three key styles, a
  hold time, and **masking**, which prints dots instead of the letters. A tool
  that draws every keystroke into a screenshot will eventually draw somebody's
  password into one, and whoever reads that file later is not necessarily
  whoever took it — masking keeps the evidence that typing happened, and its
  length, without the content.
- **The annotator** — boxes, arrows, highlights, numbered markers and
  **redaction**, burnt into the pixels rather than kept as a layer this app's
  viewer knows how to draw. A redaction fills the region with opaque black and
  **deletes the untouched copy**: a blur drawn as a layer is recoverable from
  the file underneath, which in an evidence tool is a data breach rather than a
  feature. Every other mark keeps that copy, so it can be taken back off. The
  editor says which of the two you are about to do, at the moment it becomes
  true.
- **Suggested marks** — open the editor on a step and it offers dashed boxes
  around whatever changed since the step before it. Placing the box is the part
  of writing documentation people skip. It is a suggestion and never an edit: a
  box that silently lands on the wrong thing is worse than no box in a document
  somebody is about to attach to a ticket.
- **Integrity manifests** — every capture is hashed as it is written, and zip
  exports carry a `manifest.json` and a `SHA256SUMS` a recipient can check with
  `sha256sum -c`. The Markdown report quotes the manifest's own digest, so
  altering an image breaks its entry and altering the entry breaks the report.
  **Verify** in the library re-hashes a session against what was recorded. This
  proves nothing about where a screenshot came from — no offline tool can — but
  it makes alteration after export visible, which is the claim being made.
- **Steps from a recording** — the input hook that draws the keypress HUD also
  records *when* each click and keystroke happened. Ask for it afterwards and
  each action becomes a numbered capture, taken from the frame just before it,
  so one recording becomes a step-by-step document. Never automatic: it is a
  button, it says how many steps it will make, and it asks first.
- **Settings** — all thirty-five of them, in seven declared sections with a jump list. Not
  a subset: a test walks the page's spec against the defaults in both directions
  and fails if a setting has nowhere to be changed, or if a row changes
  something that does not exist.

Not built yet:

- **Trimming a recording.** You can choose which takes to export, and now which
  frames to pull out as steps, but not which seconds of one to keep. That needs
  a real timeline.
- **Region recording.** Capture offers a dragged rectangle; Record offers a
  display or a window only.
- **Reordering steps.** They are numbered in the order they were captured, and
  a step extracted from a recording lands in the order it happened. Neither can
  be dragged into a different one.

---

## How it is put together

```
main.cjs          the main process: windows, screenshots, hotkeys, files
preload.cjs       the entire surface the page is allowed to touch
lib/              pure ESM — no Electron, no DOM, all of it unit-tested
  session.js      the session model and the rules for growing one
  store.js        the library on disk: atomic writes, renames, housekeeping
  settings.js     defaults, clamping, and accelerator validation
  export.js       what an export consists of and what it is called
  report.js       the Markdown report and its front matter
  manifest.js     digests, the integrity manifest, and verifying one
  annotate.js     the mark model: kinds, geometry, what is worth keeping
  diff.js         what changed between two captures, as rectangles
  marks.js        turning a take's input stream into a step-extraction plan
  keys.js         the keycap model for the HUD
  pdf.js          a PDF writer, ~250 lines, JPEG via /DCTDecode
  zip.js          a store-only ZIP writer
renderer/         the app UI, four views, one design system
  editor.js       the annotation editor, and burning marks into a PNG
  annotate-draw.js  one canvas renderer, shared by the editor and the burn-in
windows/
  bar.html/js     the floating transport
  region.html/js  the drag-out overlay, one per display
```

### Five decisions worth knowing about

**Three windows, each for a reason the others cannot cover.** The app window is
frameless with a custom title bar. The region overlay is transparent,
full-screen and always on top, because a click-through overlay has to sit above
every *other* application — something a page inside the app window cannot do.
There is **one overlay per display**, sized to that display, so a drag reports
coordinates in its own display's space and the multi-monitor arithmetic that
usually breaks this feature never has to be written.

**The transport is not in the recording.** `setContentProtection(true)` tells
the compositor to leave that window out of any capture —
`WDA_EXCLUDEFROMCAPTURE` on Windows, `NSWindowSharingNone` on macOS. This is the
one thing the desktop app can do that the browser extension could not: there the
bar is DOM inside the recorded tab, so a tab recording necessarily contains it.
Linux has no equivalent, so the setting exists, the UI says so, and the app does
not promise what the platform will not do.

**The renderer owns the library; main owns the machine.** Main takes the
screenshots and writes the bytes it is given, but it never decides what a
capture *means* — the renderer names it, numbers it, makes its thumbnail and
keeps the index. One writer means the `session.json` and the files beside it
cannot disagree. It is also why the renderer holds the `MediaRecorder`: it needs
a DOM, and main does not have one.

**A deleted step does not renumber the session.** The numbers are printed into
exported evidence, and somebody may already be holding a PDF that says "step 7";
silently turning a different capture into step 7 rewrites what that document
refers to. So a session can have a gap, the library shows it, and closing it is
a button the user presses. On disk the renumber goes through a staging name in
two passes — shifting every file down by one with a direct rename has step 3
overwrite step 2 before step 2 has moved.

**`lib/` knows nothing about Electron.** Every rule worth testing — what a step
number means, what a settings file is allowed to contain, which files an export
consists of — lives in a module that takes its inputs as arguments. `buildExport`
is handed a `read` and a `toJpeg` rather than reaching for the filesystem or a
canvas, so the tests run in plain Node against a Map and a stub. The 55 tests
need no browser, no display and no Electron.

### A setting nothing reads

The settings page surfaced six of twenty-one settings; the rest lived only in
the view that used them. Two were worse than missing — `countIn` and
`exportFormat` were both defined in the defaults, validated on read, written to
disk on every save, and never read by anything. The Export section's "default
format" control changed a value the library then ignored in favour of a
hard-coded `'pdf'`.

That is drift, not a one-off, so the fix is a test rather than an edit. The
page's rows are a declarative spec, and `test/ui-settings.test.mjs` walks it
against `DEFAULTS` both ways: every setting must have a row, every row must name
a real setting, and every setting must be read by something other than the page
that sets it. The second dead setting was found by that test rather than by
looking.

### Watching the keyboard

The keypress display needs to see keystrokes that are not addressed to this app,
and Electron has no API for that by design. `uiohook-napi` is the one runtime
dependency: N-API, so it survives an Electron upgrade without a rebuild, with
prebuilds for seven platform triples.

Three things about it are deliberate.

**It is loaded lazily and behind a `try`.** "The input hook did not load" has to
degrade to "the HUD is unavailable" and not to "the app will not start" — the
prebuilds do not cover every triple, and on macOS the OS refuses until
Accessibility is granted. The settings switch asks main whether the hook is
actually there and explains itself when it is not, rather than offering a
control that silently does nothing.

**The hook only runs while the setting is on.** A capture tool that watches every
keystroke for the whole session whether or not it is drawing them is not
something anyone should have to take on trust, and the switch is what makes that
claim checkable. Turning it off stops the hook, not just the drawing.

**The caps are drawn into the file, not merely floating above it.** The overlay
is hidden for the instant the shutter fires and the same caps are drawn back in
at the image's scale. That is what makes it work for a window or a region
capture — neither of which composites a window that is only floating above them
— and it is what stops a display capture containing the strip twice at two
different sizes.

A recording needs the same treatment and for the same reason, which was not
obvious until it was reported: the overlay *is* in a display recording of the
display it happens to be on, so it looked like it worked. It is not in a window
recording, which captures that window's own content and nothing above it, and it
is not in a recording of the other monitor. So when the feature is on the frames
go through a canvas — source video underneath, the same strip painted on top,
and the canvas is what gets recorded. Off, the stream is passed straight through
and it costs nothing. `lib/keys.js` holds the placement and the metrics and
`drawCaps` does the painting for both, so a keycap in a PNG and a keycap in the
video beside it cannot drift apart.

### The alignment rules

Three things in the first build were measurably, not subjectively, out. They are
worth naming because each has a general form.

**The status pill sat between two `flex: 1` spacers**, which centres it in
whatever the brand and the window controls leave over — and those are different
widths, so it landed 25px right of the window's centre, in the one element the
eye uses to judge whether a title bar is straight. Centring means taking it out
of flow.

**The rail was inset 12px on the left, 13 on the right and 14 at the bottom**,
and the selected row drew its indicator in a `::before` at `left: -12px`, poking
out through the rail's own padding so the selected row read as wider than the
others. There is one `--pad` token now, the indicator is inside the row, and
every row carries the border whether or not it is selected — so nothing shifts
by a pixel when the selection moves.

**The status pill was centred in the window**, which is at least honestly
centred — but a lone pill floating in an otherwise empty title bar reads as an
element that failed to dock somewhere. It sits beside the brand now, as the
second item in a left-hand cluster, and the middle of the title bar carries the
open session, which is what a title bar is traditionally for.

**The library's empty state lived inside the right-hand column** of the
two-column grid, so it centred itself beside a 272px sidebar — and next to a
sidebar, centred-in-the-remainder reads as shoved right. There are two states
now: nothing in the library at all drops the grid entirely and centres in the
whole view; a session that is open but empty keeps the sidebar and centres in
the content column, which is exactly where its content would have been.

**The display picker correlated two lists by index.** The tiles came from
`desktopCapturer.getSources()` and the display ids from
`screen.getAllDisplays()`, matched up by position — and those two orders are not
guaranteed to agree. On one screen it worked by accident; plug in a monitor and
picking "Screen 2" captured Screen 1, which reads as not being able to switch
screens at all. Each source already reports its own `display_id`; that is what
the tile carries now.

**Each dock was a flex row of whatever its view put in it**, so the primary
action was a different size and a different distance from the edge on every
screen; "Start recording" ended up a 450px button stranded mid-bar with nothing
to its right. The dock is a two-region grid now — context left, action right,
hard against the gutter — so the button is the same size in the same place on
all three views.

### Why no framework

The same reason as the rest of the family: a 1400px window with four views does
not need one, and `styles.css` is the token system written out by hand — roughly
what a Tailwind build of it would emit. `renderer/ui.js` builds nodes rather
than parsing HTML strings, which matters more here than it would on a web page:
every string on screen came from a window title, a file path or a session label
somebody typed, and `innerHTML` on any of those is an injection waiting for the
first window called `<img onerror=…>`.

---

## Where things are

Sessions live under the app's own data directory — Settings shows the exact
path and opens it — one folder per session:

```
<library>/<session id>/
  session.json          the index, readable and hand-editable
  step-001.png          the capture, with the pointer ring and any marks burnt in
  step-001.orig.png     the untouched copy, kept unless a redaction removed it
  step-001.thumb.png    the 480px copy the grid reads
  rec-01.mp4            a recording
```

Files rather than a database, deliberately: a capture tool whose output you
cannot find in a file manager is one people stop trusting, and "open the folder"
is a support answer that always works. `session.json` is repaired rather than
trusted on read — one malformed file must not be able to stop the app opening.

## Privacy

Nothing leaves the machine. No server, no account, no analytics, no network
request of any kind. Screenshots, recordings, encoding and export all happen
locally, and exports go exactly where you point them.

## Licence

MIT.
