import {collect, combine} from './live.mjs';

export async function runSearchBatch(job, {fetchLeg = collect, concurrency = 3} = {}) {
  const query = job.query;
  const destinations = [...new Set(query.destinations)];
  const depHour = Number(query.earliest.slice(0, 2));
  const returnFilter = {};
  if (query.returnEarliest) returnFilter.depHour = Number(query.returnEarliest.slice(0, 2));
  if (query.latest) returnFilter.arrHour = Math.min(23, Number(query.latest.slice(0, 2)) + 1);
  let next = 0;
  job.status = 'running';

  async function worker() {
    while (next < destinations.length) {
      const city = destinations[next++];
      const item = job.results[city];
      item.status = 'running';
      try {
        item.outbound = await fetchLeg(query.origin, city, query.outDate, {depHour});
        item.inbound = await fetchLeg(city, query.origin, query.backDate, returnFilter);
        const result = combine(item.outbound, item.inbound, query.earliest, query.latest, query.returnEarliest);
        Object.assign(item, result, {
          status: result.best ? 'success' : 'no_match',
          message: result.best
            ? '航班报价已返回，费用与支付金额请在购票平台核对'
            : '本次直飞候选没有满足时间和往返机场条件的组合',
        });
      } catch (error) {
        item.status = 'error';
        item.message = error.message;
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
