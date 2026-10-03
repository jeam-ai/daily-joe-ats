type Schedule = (callback: () => void, milliseconds: number) => () => void;
const scheduleTimeout: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};

/** Holding selects once; dragging/scrolling cancels, and release cannot open a profile. */
export function recordHold(
  onSelect: (id: string) => void,
  schedule: Schedule = scheduleTimeout,
) {
  let start: { x: number; y: number } | null = null;
  let cancelTimer: (() => void) | undefined;
  let cancelRelease: (() => void) | undefined;
  let held = false;
  const cancel = () => {
    cancelTimer?.();
    start = null;
  };
  const abort = () => {
    cancel();
    cancelRelease?.();
    held = false;
  };
  return {
    begin(id: string, x: number, y: number) {
      abort();
      start = { x, y };
      cancelTimer = schedule(() => {
        held = true;
        cancel();
        onSelect(id);
      }, 550);
    },
    move(x: number, y: number) {
      if (start && Math.hypot(x - start.x, y - start.y) > 10) cancel();
    },
    end() {
      cancel();
      cancelRelease = schedule(() => {
        held = false;
      }, 500);
    },
    cancel,
    abort,
    held: () => held,
    consumeClick() {
      const consume = held;
      held = false;
      return consume;
    },
  };
}
