// scripts/make_seed_codes.js
// Usage:
//   node scripts/make_seed_codes.js --target http://141-148-185-116.nip.io --n 20000 --out seed_codes.json --concurrency 50

const fs = require('fs');

function arg(name, def) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  return process.argv[idx + 1] ?? def;
}

const target = (arg('target', 'http://localhost:3000') || '').replace(/\/$/, '');
const n = parseInt(arg('n', '20000'), 10);
const out = arg('out', 'seed_codes.json');
const concurrency = parseInt(arg('concurrency', '50'), 10);
const bypassKey = 'bypass';

function genUrl(i) {
  return `https://example.com/seed/${i}`;
}

async function postShorten(i) {
  const res = await fetch(`${target}/shorten`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-loadtest-key': bypassKey,
    },
    body: JSON.stringify({ url: genUrl(i) }),
  });

  if (res.status !== 201) {
    const text = await res.text().catch(() => '');
    throw new Error(`shorten failed i=${i} status=${res.status} body=${text}`);
  }

  const json = await res.json();
  if (!json.code) throw new Error(`missing code i=${i} body=${JSON.stringify(json)}`);
  return json.code;
}

async function main() {
  console.log(`Target: ${target}`);
  console.log(`Creating ${n} codes with concurrency=${concurrency}...`);

  const codes = [];
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= n) return;
      const code = await postShorten(i);
      codes[i] = code; // keep stable order
      if ((i + 1) % 1000 === 0) console.log(`... ${i + 1}/${n}`);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  fs.writeFileSync(out, JSON.stringify(codes), 'utf-8');
  console.log(`Done. Wrote ${codes.length} codes to ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
