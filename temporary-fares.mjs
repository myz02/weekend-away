export function nextShanghaiNoon(now) {
  const day = now.toLocaleDateString('sv-SE', {timeZone: 'Asia/Shanghai'});
  const noon = new Date(day + 'T12:00:00+08:00');
  if (now >= noon) noon.setUTCDate(noon.getUTCDate() + 1);
  return noon.toISOString();
}

export function openTemporaryFares(store, fetchLeg, now) {
  const pending = new Map();

  async function get(from, to, date, filter) {
    const {depHour, arrHour} = filter;
    const leg = {mode:'flight', scope:'temporary', from, to, date, depHour, arrHour};
    const stored = store.getLeg(leg, now().toISOString());
    if (stored) return stored;
    const key = JSON.stringify(leg);
    if (!pending.has(key)) {
      const request = (async () => {
        const result = await fetchLeg(from, to, date, filter);
        const expiresAt = nextShanghaiNoon(now());
        const temporary = {...result, temporaryExpiresAt: expiresAt};
        store.saveLeg(leg, temporary, expiresAt);
        return temporary;
      })().finally(() => pending.delete(key));
      pending.set(key, request);
    }
    return pending.get(key);
  }

  return {get, sweep: () => store.sweepExpired(now().toISOString())};
}
