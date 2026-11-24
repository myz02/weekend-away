import {collect, combine} from './live.mjs';

export async function runSearchBatch(job, {fetchLeg = collect, fetchAlternateLeg, concurrency = 3} = {}) {
  const query = job.query;
  const destinations = [...new Set(query.destinations)];
  const depHour = Number(query.earliest.slice(0, 2));
  const returnFilter = {};
  if (query.returnEarliest) returnFilter.depHour = Number(query.returnEarliest.slice(0, 2));
  if (query.latest) returnFilter.arrHour = Math.min(23, Number(query.latest.slice(0, 2)) + 1);
  let next = 0;
  job.status = 'running';

  async function searchPair(fetch, city) {
    const outbound = await fetch(query.origin, city, query.outDate, {depHour});
    const inbound = await fetch(city, query.origin, query.backDate, returnFilter);
    const result = combine(outbound, inbound, query.earliest, query.latest, query.returnEarliest);
    return {...result, outbound, inbound, status:result.best ? 'success' : 'no_match',
      message:result.best ? '航班报价已返回，费用与支付金额请在购票平台核对' : '没有满足所选时间和机场条件的直飞往返组合'};
  }

  async function searchCity(item, city) {
    try {
      Object.assign(item, await searchPair(fetchLeg, city));
    } catch (error) {
      Object.assign(item, {status:'error', message:error.message, code:error.code});
    }
    if (!fetchAlternateLeg || Number.isFinite(item.best?.total)) return;
    try {
      const alternate = await searchPair(fetchAlternateLeg, city);
      if (Number.isFinite(alternate.best?.total)) {
        Object.assign(item, alternate);
        delete item.code;
        return;
      }
      if (item.status === 'no_match') return;
      if (item.status === 'error') item.message += '。同程未取得符合条件的往返报价。';
    } catch (error) {
      if (query.cacheOnly) {
        if (item.status === 'no_match') Object.assign(item, {status:'error', message:error.message});
        return;
      }
      if (item.status === 'no_match') item.status = 'error';
      if (item.status === 'error') {
        item.message += `。${error.message}。`;
        item.alternateCode = error.code;
      }
    }
    if (!query.cacheOnly) item.fallbackAttempted = true;
  }

  async function worker() {
    while (next < destinations.length) {
      const city = destinations[next++];
      const item = job.results[city];
      item.status = 'running';
      try {
        await searchCity(item, city);
      } finally {
        item.collectedAt = new Date().toISOString();
        job.completed++;
      }
    }
  }

  try {
    await Promise.all(Array.from({length: Math.min(concurrency, destinations.length)}, worker));
  } finally {
    job.status = 'complete';
    job.finishedAt = new Date().toISOString();
  }
}
