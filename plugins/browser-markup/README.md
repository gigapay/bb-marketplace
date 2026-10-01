# bb-plugin-browser-markup

Screenshot a desktop Browser tab, draw on it, then copy the image or add it to the prompt. It's the "Draw on screenshot" flow from [Orca](https://github.com/stablyai/orca), and the drawing model and renderer are ported from there (MIT).

## Using it

Open a page in a Browser tab of the desktop app and click the camera button in the Browser toolbar. The editor opens in a panel tab next to the Browser tab, on a frozen capture of the visible viewport. It's a tab rather than a dialog because the native Browser view paints above every in-app overlay. Pick a tool (pen, highlighter, arrow, rectangle, ellipse, text), a color and a width, and draw. Ctrl+Z / Ctrl+Shift+Z undo and redo (Cmd on macOS). In a text box, Shift+Enter adds a line and the mic button dictates text with BB's voice transcription (the same service as the composer mic).

Then pick one:

- Copy image: the flattened PNG goes on the clipboard. Paste it into the composer and BB attaches it like any pasted image, thumbnail included.
- Add to prompt: the PNG lands in the thread's composer as a regular image attachment, thumbnail included. The SDK has no attachment API, so the plugin drops the file on the composer form and lets BB's own attachment flow take it. If it can't pick a single composer, it falls back to an `@Screenshot <host>` mention that resolves to the image at send time.

## How it's wired

- `app.tsx` registers the `experimental_browserToolbarAction` button and the editor dialog.
- `capture.ts` finds the tab's desktop host, window instance and generation (the toolbar slot only knows the thread and tab ids), then calls `experimental_desktopBrowsers.captureTab`.
- `MarkupEditor.tsx`, `markup-model.ts` and `markup-render.ts` hold the canvas editor. Shapes are stored in screenshot pixels so the preview and the export match.
- `composer-attach.ts` drops the PNG on the focused composer form.
- `server.ts` saves each screenshot reference in plugin storage and registers the `screenshot` mention provider, which returns the image through `experimental_images`.

## Limits

Desktop app only and visible viewport only. Attaching relies on the composer accepting dropped files, which isn't a public contract. Every BB API used here is still `experimental_`, so a BB upgrade can break it.
