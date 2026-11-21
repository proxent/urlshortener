// This preloader is only mounted into the isolated capacity benchmark.
const mode = process.env.LAB_HIT_WRITES;
const url = new URL(process.env.DATABASE_URL);
if (!['on', 'off'].includes(mode) || url.hostname !== 'db' ||
    url.username !== 'bench' || !/^\/bench_r\d+$/.test(url.pathname)) {
  throw new Error('Hit-write comparison requires an isolated synthetic database');
}
if (mode === 'off') {
  const { shortenerStore } = require('/app/dist/shortenerStore.js');
  shortenerStore.incrementHit = async () => {};
}
console.log('HIT_WRITE_LAB ' + mode);
