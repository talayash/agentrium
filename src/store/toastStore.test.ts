import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore, toast } from './toastStore';

describe('toastStore', () => {
  beforeEach(() => {
    useToastStore.getState().clearAll();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('addToast appends a toast and returns its id', () => {
    const id = useToastStore.getState().addToast({ type: 'info', title: 'hello' });
    const toasts = useToastStore.getState().toasts;

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ id, type: 'info', title: 'hello' });
    expect(toasts[0].duration).toBe(4000);
  });

  it('applies the per-type default duration when none is provided', () => {
    const { addToast } = useToastStore.getState();
    addToast({ type: 'success', title: 's' });
    addToast({ type: 'info', title: 'i' });
    addToast({ type: 'warning', title: 'w' });
    addToast({ type: 'error', title: 'e' });

    const durations = useToastStore.getState().toasts.map((t) => t.duration);
    expect(durations).toEqual([3000, 4000, 5000, 6000]);
  });

  it('honours an explicit duration override', () => {
    useToastStore.getState().addToast({ type: 'success', title: 's', duration: 50 });
    expect(useToastStore.getState().toasts[0].duration).toBe(50);
  });

  it('caps the toast list at MAX_TOASTS (5), evicting oldest', () => {
    const { addToast } = useToastStore.getState();
    for (let i = 0; i < 8; i++) {
      addToast({ type: 'info', title: `t${i}`, duration: 0 });
    }

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(5);
    expect(toasts.map((t) => t.title)).toEqual(['t3', 't4', 't5', 't6', 't7']);
  });

  it('auto-dismisses a toast once its duration elapses', () => {
    const id = useToastStore.getState().addToast({
      type: 'success',
      title: 'bye',
      duration: 1000,
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(1);
    const remaining = useToastStore.getState().toasts;
    expect(remaining.find((t) => t.id === id)).toBeUndefined();
  });

  it('does not auto-dismiss when duration is 0', () => {
    useToastStore.getState().addToast({
      type: 'info',
      title: 'sticky',
      duration: 0,
    });

    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('removeToast removes only the matching id', () => {
    const { addToast, removeToast } = useToastStore.getState();
    const a = addToast({ type: 'info', title: 'a', duration: 0 });
    addToast({ type: 'info', title: 'b', duration: 0 });

    removeToast(a);

    const remaining = useToastStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('b');
  });

  it('clearAll empties the toast list', () => {
    const { addToast, clearAll } = useToastStore.getState();
    addToast({ type: 'info', title: 'a', duration: 0 });
    addToast({ type: 'info', title: 'b', duration: 0 });

    clearAll();

    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('issues a unique id per addToast call', () => {
    const { addToast } = useToastStore.getState();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      ids.add(addToast({ type: 'info', title: `t${i}`, duration: 0 }));
    }
    expect(ids.size).toBe(20);
  });

  it('toast.* convenience helpers route to the correct toast type', () => {
    toast.success('s');
    toast.error('e');
    toast.warning('w');
    toast.info('i');

    const types = useToastStore.getState().toasts.map((t) => t.type);
    expect(types).toEqual(['success', 'error', 'warning', 'info']);
  });

  it('stamps each toast with the time it was created', () => {
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'));

    useToastStore.getState().addToast({ type: 'info', title: 'stamped', duration: 0 });

    expect(useToastStore.getState().toasts[0].createdAt).toBe(Date.now());
  });

  it('keeps a toast that asks a question on screen until it is answered', () => {
    useToastStore.getState().addToast({
      type: 'error',
      title: 'Push rejected',
      actions: [{ label: 'Pull and Retry', onClick: () => {} }],
    });

    expect(useToastStore.getState().toasts[0].duration).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('still honours an explicit duration on a toast that has actions', () => {
    useToastStore.getState().addToast({
      type: 'info',
      title: 'fleeting',
      duration: 1000,
      actions: [{ label: 'Undo', onClick: () => {} }],
    });

    expect(useToastStore.getState().toasts[0].duration).toBe(1000);

    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('pauseAutoDismiss holds a toast on screen past its duration', () => {
    const { addToast, pauseAutoDismiss } = useToastStore.getState();
    const id = addToast({ type: 'info', title: 'hovered', duration: 1000 });

    vi.advanceTimersByTime(400);
    pauseAutoDismiss(id);
    vi.advanceTimersByTime(60_000);

    expect(useToastStore.getState().toasts.find((t) => t.id === id)).toBeDefined();
  });

  it('resumeAutoDismiss waits only the time that was left when it paused', () => {
    const { addToast, pauseAutoDismiss, resumeAutoDismiss } = useToastStore.getState();
    const id = addToast({ type: 'info', title: 'hovered', duration: 1000 });

    vi.advanceTimersByTime(400);
    pauseAutoDismiss(id);
    vi.advanceTimersByTime(60_000);
    resumeAutoDismiss(id);

    vi.advanceTimersByTime(599);
    expect(useToastStore.getState().toasts.find((t) => t.id === id)).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts.find((t) => t.id === id)).toBeUndefined();
  });

  it('pausing a toast that never auto-dismisses is a no-op', () => {
    const { addToast, pauseAutoDismiss, resumeAutoDismiss } = useToastStore.getState();
    const id = addToast({ type: 'info', title: 'sticky', duration: 0 });

    pauseAutoDismiss(id);
    resumeAutoDismiss(id);
    vi.advanceTimersByTime(60_000);

    expect(useToastStore.getState().toasts.find((t) => t.id === id)).toBeDefined();
  });
});
