import type { IMarker, Terminal } from '@xterm/xterm';

/** Attach one overlay to its terminal; no private xterm internals required. */
export function attachTerminalScrollbar(container: HTMLElement, terminal: Terminal, mode: string) {
  const track = document.createElement('div');
  track.className = 'terminal-scrollbar';
  track.setAttribute('role', 'scrollbar');
  track.setAttribute('aria-label', 'Terminal scrollback');
  track.setAttribute('aria-orientation', 'vertical');
  track.setAttribute('aria-valuemin', '0');
  track.tabIndex = 0;
  const thumb = document.createElement('div');
  thumb.className = 'terminal-scrollbar-thumb';
  track.append(thumb);
  container.append(track);
  // "Jump to start of last response": the line where the user last pressed
  // Enter is where the agent's latest output begins. An xterm marker follows
  // that line as the buffer scrolls and is disposed if scrollback trims it.
  const jumpToStart = document.createElement('button');
  jumpToStart.type = 'button';
  jumpToStart.className = 'terminal-jump-start';
  jumpToStart.textContent = '↑';
  jumpToStart.title = 'Jump to start of last response';
  jumpToStart.setAttribute('aria-label', 'Jump to start of last response');
  jumpToStart.hidden = true;
  container.append(jumpToStart);
  let responseStart: IMarker | undefined;
  const responseStartLine = () =>
    responseStart && !responseStart.isDisposed && responseStart.line >= 0 ? responseStart.line : -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let drag: { y: number; top: number; pointer: number } | undefined;
  let thumbHeight = 0;
  let hovered = false;
  let wasScrollable = false;
  let wasScrolledUp = false;

  const isAlternate = () => terminal.buffer.active.type === 'alternate';
  const scrollLines = (lines: number) => terminal.scrollLines(lines);
  const reveal = () => {
    track.classList.add('is-visible');
    clearTimeout(timer);
    timer = setTimeout(() => {
      const buffer = terminal.buffer.active;
      if (!drag && !hovered && buffer.viewportY >= buffer.baseY) track.classList.remove('is-visible');
    }, 1500);
  };
  const update = () => {
    frame = 0;
    const buffer = terminal.buffer.active;
    const alternate = isAlternate();
    const scrollable = !alternate && buffer.baseY > 0;
    const scrolledUp = scrollable && buffer.viewportY < buffer.baseY;
    if ((scrollable && !wasScrollable) || scrolledUp || (wasScrolledUp && !scrolledUp)) reveal();
    wasScrollable = scrollable;
    wasScrolledUp = scrolledUp;
    // Alternate-screen applications own their history. xterm has no position
    // or extent for it, so never draw a fabricated thumb (previously 50%).
    track.hidden = mode === 'hidden' || !scrollable;
    // Only useful when the response start is above the top of the viewport,
    // i.e. the response is longer than what is on screen. Alternate-screen
    // apps (Claude Code fullscreen, vim) keep no scrollback, so never there.
    const start = responseStartLine();
    jumpToStart.hidden = mode === 'hidden' || !scrollable || start < 0 || buffer.viewportY <= start;
    if (track.hidden && drag) endDrag();
    track.title = 'Scroll terminal history';
    const height = track.clientHeight;

    thumbHeight = Math.min(height, Math.max(28, height * terminal.rows / (buffer.baseY + terminal.rows)));
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${buffer.baseY ? (height - thumbHeight) * buffer.viewportY / buffer.baseY : 0}px)`;
    track.setAttribute('aria-valuemax', String(buffer.baseY));
    track.setAttribute('aria-valuenow', String(buffer.viewportY));
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  if (mode === 'always') track.classList.add('is-always-visible');
  track.onpointerenter = () => { hovered = true; reveal(); };
  track.onpointerleave = () => { hovered = false; reveal(); };
  track.onpointerdown = (event) => {
    if (event.button !== 0 || isAlternate() || track.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    const buffer = terminal.buffer.active;
    if (event.target !== thumb) {
      const top = thumb.getBoundingClientRect().top;
      scrollLines(event.clientY < top ? -terminal.rows : terminal.rows);
    } else {
      drag = { y: event.clientY, top: buffer.viewportY, pointer: event.pointerId };
      track.setPointerCapture(event.pointerId);
      track.classList.add('is-dragging');
    }
    reveal();
  };
  track.onpointermove = (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (isAlternate()) { endDrag(); return; }
    const travel = track.clientHeight - thumbHeight;
    if (travel > 0) terminal.scrollToLine(Math.round(drag.top + (event.clientY - drag.y) * terminal.buffer.active.baseY / travel));
  };
  const endDrag = () => {
    const pointer = drag?.pointer;
    drag = undefined;
    if (pointer !== undefined && track.hasPointerCapture(pointer)) track.releasePointerCapture(pointer);
    track.classList.remove('is-dragging');
    reveal();
  };
  track.onpointerup = endDrag;
  track.onpointercancel = endDrag;
  track.onlostpointercapture = endDrag;
  track.onkeydown = (event) => {
    if (isAlternate() || track.hidden) return;
    switch (event.key) {
      case 'ArrowUp': scrollLines(-1); break;
      case 'ArrowDown': scrollLines(1); break;
      case 'PageUp': scrollLines(-terminal.rows); break;
      case 'PageDown': scrollLines(terminal.rows); break;
      case 'Home': terminal.scrollToTop(); break;
      case 'End': terminal.scrollToBottom(); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    reveal();
  };
  track.onmousedown = (event) => event.stopPropagation();
  jumpToStart.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const start = responseStartLine();
    if (start >= 0) terminal.scrollToLine(start);
    reveal();
  };
  jumpToStart.onmousedown = (event) => event.stopPropagation();
  container.addEventListener('pointermove', reveal);
  container.addEventListener('wheel', reveal, { passive: true });
  // xterm suppresses its public onScroll event for native viewport scrolling.
  // Read the buffer on the next frame, after xterm processes the DOM event.
  const viewport = container.querySelector('.xterm-viewport');
  viewport?.addEventListener('scroll', schedule, { passive: true });
  const markResponseStart = (data: string) => {
    // Enter submits a prompt. registerMarker returns undefined on the
    // alternate screen, which correctly leaves no jump target there.
    if (!data || !data.includes('\r') || isAlternate()) return;
    responseStart?.dispose();
    responseStart = terminal.registerMarker(0);
    schedule();
  };
  const subscriptions = [terminal.onData(markResponseStart), terminal.onScroll(schedule), terminal.onWriteParsed(schedule), terminal.onResize(schedule), terminal.buffer.onBufferChange(schedule)];
  const observer = new ResizeObserver(schedule);
  observer.observe(container);
  update();
  return () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    observer.disconnect();
    subscriptions.forEach(subscription => subscription.dispose());
    container.removeEventListener('pointermove', reveal);
    container.removeEventListener('wheel', reveal);
    viewport?.removeEventListener('scroll', schedule);
    responseStart?.dispose();
    track.remove();
    jumpToStart.remove();
  };
}
