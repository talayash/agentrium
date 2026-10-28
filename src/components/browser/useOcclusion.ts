import { useEffect, useState, type RefObject } from 'react';

// Floating UI that must stay visible above the browser page. The native
// webview draws over the whole DOM, so when any of these overlaps the page
// slot the page is hidden instead. Tooltips (pointer-events: none) and the
// toast stack (data-browser-overlay-ignore) are deliberately excluded so
// hovering a button or a passing toast doesn't blank the page.
const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.material-overlay',
  '.material-sheet',
  '.material-popover',
].join(',');

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function isOccluded(slot: HTMLElement): boolean {
  const r = slot.getBoundingClientRect();
  for (const el of document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
    if (slot.contains(el) || el.closest('[data-browser-overlay-ignore]')) continue;
    const cs = getComputedStyle(el);
    if (cs.pointerEvents === 'none' || cs.visibility === 'hidden' || cs.display === 'none') continue;
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && overlaps(b, r)) return true;
  }
  return false;
}

/** True while any modal, menu or popover overlaps `ref`. */
export function useOcclusion(ref: RefObject<HTMLElement | null>): boolean {
  const [occluded, setOccluded] = useState(false);

  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const el = ref.current;
      if (el) setOccluded(isOccluded(el));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref]);

  return occluded;
}
