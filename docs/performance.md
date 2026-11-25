# Performance

Quiet Office runs all day on your desktop. It has to cost close to nothing.

## Measured cost

Machine: Intel Mac, Core i9, Radeon 5700 XT, one 1600×900 pt display, macOS.
Sum of the host, WebKit GPU, WebKit WebContent and server processes, as a percentage of one core.

| State | CPU (one core) |
|---|---|
| Visible, frame skipping on | 4.08–4.75% |
| Visible, one sample split by process | host 1.07, GPU 1.43, WebContent 1.63, server 0.50 = 4.65% |
| Covered, locked or display asleep | about 1% or less, mostly the server |

Windows and Linux have no measurements yet.

## What keeps it cheap

### 1. Pause when nobody can see it

The host calls `pause()` when:

- at least 90% of the desktop is covered by app windows,
- the session is locked,
- the display or the system sleeps,
- the screensaver runs,
- the user picked a timed pause, or turned the wallpaper off.

Paused, the page stops its frame loop and freezes CSS animations. It also pauses itself when the document is hidden.
The server keeps polling, so the state is fresh on resume.

### 2. Low frame rate

| Situation | fps |
|---|---|
| Anyone walks or spawns | 12 |
| Everyone sits | 10 |

The host calls `resume(12)`. The page drops to 10 by itself.

### 3. Frame skipping

File: `web/pixel-agents/webview-ui/src/office/engine/frameRecorder.ts`

- The renderer draws into a recorder, not into the canvas.
- The recorder keeps every call and property write and builds a signature.
- Images compare by identity. Sprite and floor caches create a new canvas when content changes, never redraw one in place.
- Same signature as the last drawn frame: the canvas stays untouched. No raster, no GPU composite.
- Different signature: the recorder replays the calls on the real canvas.

A seated office with typing animations still changes some frames. A still office changes almost none.

### 4. Cheap pixels

- DPR is forced to 1 with `image-rendering: pixelated`. The canvas is not rendered at 2× on Retina displays.
- No toolbars, overlays or sound in wallpaper mode.

### 5. Cheap server

- One poll every 750 ms over small session files.
- Transcripts are read incrementally. The first read takes the last 256 KB, later reads take new bytes only.
- Today's counts rescan file timestamps once a minute.
- No dependencies, no build step.

## Measure it yourself

macOS:

```sh
top -l 0 -s 5 -stats pid,command,cpu | grep -E 'QuietOffice|WebContent|GPU|node'
```

Linux:

```sh
pidstat -u 5 -C 'quiet-office|WebKit|node'
```

Windows: Task Manager, Details tab, CPU column for the host, `msedgewebview2.exe` and `node.exe`.

Measure for at least one minute with the wallpaper visible and nobody walking.
