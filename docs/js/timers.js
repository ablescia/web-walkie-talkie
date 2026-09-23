// Timers that keep their pace while the page is in the background.
//
// Browsers slow the timers of a hidden page down: Chrome runs them at most once
// a minute after five minutes in the background, which would starve the presence
// heartbeat (peers would see the radio disappear) and the connection watchdog.
// Timers inside a Web Worker are not throttled, so a tiny worker keeps the time
// and posts a message for every tick; the callback still runs on the main thread.
// Where workers are unavailable it falls back to the window timers.

const WORKER_SOURCE = `
const timers = new Map();
onmessage = ({ data: { op, id, ms } }) => {
  if (op === "clear") {
    clearTimeout(timers.get(id));
    clearInterval(timers.get(id));
    timers.delete(id);
  } else if (op === "interval") {
    timers.set(id, setInterval(() => postMessage(id), ms));
  } else {
    timers.set(id, setTimeout(() => { timers.delete(id); postMessage(id); }, ms));
  }
};`;

const pending = new Map(); // id -> {fn, once, native?}; native is set when using window timers
let worker; // undefined = not created yet, null = unavailable
let seq = 0;

function getWorker() {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" })));
    worker.onmessage = ({ data: id }) => {
      const timer = pending.get(id);
      if (!timer) return;
      if (timer.once) pending.delete(id);
      timer.fn();
    };
  } catch (err) {
    console.warn("[timers] worker unavailable, using window timers", err);
    worker = null;
  }
  return worker;
}

function start(fn, ms, once) {
  const id = ++seq;
  const w = getWorker();
  if (w) {
    pending.set(id, { fn, once });
    w.postMessage({ op: once ? "timeout" : "interval", id, ms });
  } else {
    const native = once
      ? setTimeout(() => {
          pending.delete(id);
          fn();
        }, ms)
      : setInterval(fn, ms);
    pending.set(id, { fn, once, native });
  }
  return id;
}

export const timers = {
  /** Like window.setInterval; the returned id is for timers.clear(). */
  setInterval: (fn, ms) => start(fn, ms, false),
  /** Like window.setTimeout; the returned id is for timers.clear(). */
  setTimeout: (fn, ms) => start(fn, ms, true),
  /** Cancels a timer created by setInterval or setTimeout. Unknown ids are ignored. */
  clear(id) {
    const timer = pending.get(id);
    if (!timer) return;
    pending.delete(id);
    if (timer.native === undefined) {
      worker.postMessage({ op: "clear", id });
    } else {
      clearTimeout(timer.native);
      clearInterval(timer.native);
    }
  },
};
