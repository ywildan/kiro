/** Lines moved per wheel notch. */
export const MOUSE_SCROLL_LINES = 3;

/**
 * Enables button/wheel reporting with SGR coordinates; paired with MOUSE_OFF.
 * xterm has no wheel-only mode, so turning this on also hands clicks to Kiro
 * instead of starting a text selection — copy/paste then needs Shift+drag.
 */
export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
const SGR_MOUSE_ONLY = /^(?:\[<\d+;\d+;\d+[Mm])+$/;
const X10_MOUSE_ONLY = /^(?:\[M[\s\S]{3})+$/;

/** Returns the signed number of lines a wheel event should scroll. */
export function parseMouseWheel(text: string): number {
  let lines = 0;
  for (const match of text.matchAll(SGR_MOUSE)) {
    const button = Number(match[1]);
    if ((button & 64) === 0) continue;
    const direction = button & 3;
    if (direction === 0) lines -= MOUSE_SCROLL_LINES;
    else if (direction === 1) lines += MOUSE_SCROLL_LINES;
  }
  return lines;
}

/**
 * Ink strips the leading ESC before handing a sequence to useInput, while raw
 * stdin listeners see it intact, so accept both forms.
 */
export function isMouseSequence(text: string): boolean {
  const stripped = text.startsWith('\x1b') ? text.slice(1) : text;
  return SGR_MOUSE_ONLY.test(stripped) || X10_MOUSE_ONLY.test(stripped);
}
