import {setTimeout as sleep} from 'node:timers/promises';

export function spaceRequestStarts(intervalMs, {now = () => performance.now(), wait = sleep} = {}) {
  let previousStart = Promise.resolve();
  let lastStart = -Infinity;

  return request => {
    const start = previousStart.then(async () => {
      let remaining = intervalMs - (now() - lastStart);
      while (remaining > 0) {
        await wait(Math.ceil(remaining));
        remaining = intervalMs - (now() - lastStart);
      }
      lastStart = now();
    });
    previousStart = start;
    return start.then(request);
  };
}
