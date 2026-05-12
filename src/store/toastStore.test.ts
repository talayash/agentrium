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
});
