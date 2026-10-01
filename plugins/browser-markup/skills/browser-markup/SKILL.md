---
name: browser-markup
description: Explain or troubleshoot the Browser Markup plugin, which screenshots a desktop Browser tab, lets the user draw on it, and copies it or adds it to the prompt. Use when the user asks how to annotate a screenshot of a page, or when a prompt carries an @Screenshot mention.
---

# Browser markup

In a desktop Browser tab, the camera button in the Browser toolbar captures the visible viewport and opens an editor. The editor has a pen, a highlighter, arrows, rectangles, ellipses and text, seven colors, three stroke widths, a font-size stepper, and undo/redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y). Cmd replaces Ctrl on macOS. In a text box, Enter places the text, Shift+Enter starts a new line, Escape drops it, and the mic button next to the box dictates text through BB's voice transcription.

The editor opens as a panel tab next to the Browser tab, because the native Browser view paints above any in-app overlay. Close the tab when done.

Two ways out of the editor:

- Copy image puts a PNG on the clipboard. Pasting it into a composer makes a normal image attachment with a thumbnail.
- Add to prompt attaches the PNG to the thread's composer as a regular image attachment, thumbnail included. When no single composer can be found (several side chats open), it falls back to an `@Screenshot <host>` mention that resolves to the image plus the page URL at send time.

## For agents

An attached screenshot or an `@Screenshot` mention means the user drew on the page to point at something. Read the attached image first; arrows, boxes, highlights and text are the user's markup, not part of the page.

## Limits

- Desktop app only. The button is disabled in the web app.
- Captures the visible viewport, not the full scrollable page.
- Add to prompt works by dropping the file on the composer form, since the SDK has no attachment API. A BB change to the composer can break it, in which case the mention fallback still works.
- It relies on experimental BB APIs (`experimental_browserToolbarAction`, `experimental_desktopBrowsers.captureTab`, mention `experimental_images`), which can change between BB releases.
