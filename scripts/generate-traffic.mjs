#!/usr/bin/env node
// Sends demo traffic to each tenant domain with a different pattern, so the
// per-tenant views have something to show:
//   tenant-a: high volume, mostly cacheable static content
//   tenant-b: medium volume, about 30% server errors
//   tenant-c: low volume, some not-found responses
//
// Usage: node scripts/generate-traffic.mjs <minutes> <domain-a> <domain-b> <domain-c>

const [minutesArg, ...domains] = process.argv.slice(2);
const minutes = Number(minutesArg);
if (!minutes || domains.length === 0) {
  console.error('Usage: node scripts/generate-traffic.mjs <minutes> <tenant-domain> [<tenant-domain> ...]');
  process.exit(1);
}

const patterns = [
  { perSecond: 10, paths: ['/static/app.js', '/static/logo.png', '/static/style.css', '/'] },
  { perSecond: 4, paths: ['/', '/', '/error', '/api/orders', '/error', '/', '/api/orders', '/', '/', '/error'] },
  { perSecond: 1, paths: ['/', '/missing', '/', '/static/app.js'] },
];

const pick = (items) => items[Math.floor(Math.random() * items.length)];
const counts = Object.fromEntries(domains.map((d) => [d, {}]));

async function request(domain, path) {
  try {
    const response = await fetch(`https://${domain}${path}`, { signal: AbortSignal.timeout(10_000) });
    await response.arrayBuffer();
    counts[domain][response.status] = (counts[domain][response.status] ?? 0) + 1;
  } catch {
    counts[domain].failed = (counts[domain].failed ?? 0) + 1;
  }
}

const end = Date.now() + minutes * 60_000;
while (Date.now() < end) {
  const batch = domains.flatMap((domain, i) => {
    const { perSecond, paths } = patterns[i % patterns.length];
    return Array.from({ length: perSecond }, () => request(domain, pick(paths)));
  });
  await Promise.all([...batch, new Promise((resolve) => setTimeout(resolve, 1000))]);
}

console.log(JSON.stringify(counts, null, 2));
