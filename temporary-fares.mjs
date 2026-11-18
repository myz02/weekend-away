import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

export function nextShanghaiNoon(now) {
  const day = now.toLocaleDateString('sv-SE', {timeZone: 'Asia/Shanghai'});
  const noon = new Date(day + 'T12:00:00+08:00');
  if (now >= noon) noon.setUTCDate(noon.getUTCDate() + 1);
  return noon.toISOString();
}

export async function openTemporaryFares(file, fetchLeg, now, validLeg) {
  let entries = {};
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) entries = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('无法读取临时票价缓存', error.message);
  }
  const pending = new Map();
  let writes = Promise.resolve();

  function persist() {
    writes = writes.catch(() => {}).then(async () => {
      if (!Object.keys(entries).length) {
        await rm(file, {force: true});
        return;
      }
      await mkdir(dirname(file), {recursive: true});
      await writeFile(file + '.tmp', JSON.stringify(entries));
      await rename(file + '.tmp', file);
    });
    return writes.catch(error => console.warn('无法保存临时票价缓存', error.message));
  }

  async function sweep() {
    const time = now().toISOString();
    const expired = Object.keys(entries).filter(key => {
      if (entries[key].expiresAt <= time) return true;
      try {
        const [from, to] = JSON.parse(key);
        return !validLeg(from, to);
      } catch {
        return true;
      }
    });
    if (!expired.length) return;
    for (const key of expired) delete entries[key];
    await persist();
  }

  async function get(from, to, date, filter) {
    const key = JSON.stringify([from, to, date, filter.depHour ?? null, filter.arrHour ?? null]);
    const stored = entries[key];
    if (stored?.expiresAt > now().toISOString()) return stored.result;
    if (!pending.has(key)) {
      const request = (async () => {
        const result = await fetchLeg(from, to, date, filter);
        const expiresAt = nextShanghaiNoon(now());
        const temporary = {...result, temporaryExpiresAt: expiresAt};
        entries[key] = {expiresAt, result: temporary};
        await persist();
        return temporary;
      })().finally(() => pending.delete(key));
      pending.set(key, request);
    }
    return pending.get(key);
  }

  return {get, sweep};
}
