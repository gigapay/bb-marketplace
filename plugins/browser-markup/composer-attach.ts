// The plugin SDK can't add attachments to the composer, but the composer's
// form takes dropped files through its native attachment flow (upload,
// thumbnail, delivery to the thread's machine). Dropping the file there
// gives the same result as the user pasting the image.

function findPromptBox(): HTMLFormElement | null {
  const active = document.activeElement;
  const focused = active instanceof Element ? active.closest("form[data-promptbox]") : null;
  if (focused instanceof HTMLFormElement) return focused;
  const visible = Array.from(document.querySelectorAll("form[data-promptbox]")).filter(
    (form) => form instanceof HTMLFormElement && form.getClientRects().length > 0,
  );
  // Several composers (side chats) are ambiguous; the caller falls back.
  return visible.length === 1 ? (visible[0] as HTMLFormElement) : null;
}

/** Attaches `file` to the focused composer; false when none was found. */
export function attachFileToComposer(file: File): boolean {
  const form = findPromptBox();
  if (form === null) return false;
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  const init = { bubbles: true, cancelable: true, dataTransfer };
  form.dispatchEvent(new DragEvent("dragover", init));
  // React's handler calls preventDefault when it accepted the drop.
  return !form.dispatchEvent(new DragEvent("drop", init));
}
