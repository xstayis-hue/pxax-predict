// Публикация VIP-фида в Cloudflare KV.
//
// Зачем: PRO-прогнозы больше не лежат в публичном data/predictions.json (иначе их
// скачивал бы кто угодно curl-ом). Генератор пишет их в data/pro-feed.json, а этот
// скрипт заливает фид в KV воркера — оттуда его отдаёт /api/pro и только подписчику.
//
// Запуск (в CI — шагом после генерации):
//   PXAX_WORKER_URL=https://... PXAX_ADMIN_KEY=... node scripts/publish-pro.mjs
// Оба значения приходят из секретов репозитория, в коде их нет.
import { readFileSync, existsSync } from 'node:fs';

const url = (process.env.PXAX_WORKER_URL || '').replace(/\/+$/, '');
const key = process.env.PXAX_ADMIN_KEY || '';
const file = process.env.PXAX_PRO_FEED || 'data/pro-feed.json';

if (!url || !key) {
  console.error('publish-pro: PXAX_WORKER_URL/PXAX_ADMIN_KEY обязательны — VIP-фид не публикуется');
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`publish-pro: ${file} отсутствует — VIP-фид не публикуется`);
  process.exit(1);
}

const feed = JSON.parse(readFileSync(file, 'utf8'));
const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() + 3 * 3600e3 - 86400e3).toISOString().slice(0, 10);
const generated = new Date(feed.generated || '').getTime();
if (!feed.date || ![today, yesterday].includes(feed.date) || !Array.isArray(feed.predictions)
  || !Number.isFinite(generated) || generated > Date.now() + 5 * 60 * 1000 || Date.now() - generated > 8 * 3600e3) {
  console.error(`publish-pro: invalid or stale real feed for ${today}`);
  process.exit(1);
}
const ids = feed.predictions.map(p => String(p.id ?? ''));
if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
  console.error('publish-pro: prediction IDs must be present and unique');
  process.exit(1);
}
// страховка от утечки: в VIP-фиде не должно быть бесплатных прогнозов
const leaked = feed.predictions.filter((p) => p.tier && p.tier !== 'pro');
if (leaked.length) {
  console.error(`publish-pro: в фиде ${leaked.length} не-PRO прогнозов — не публикую`);
  process.exit(1);
}
const proCount = Number(feed.proCount ?? feed.count);
if (!feed.targets || !feed.limits || !feed.shortfall || feed.targets.free !== 3 || feed.targets.pro !== 3
  || feed.limits.free !== 5 || feed.limits.pro !== 5
  || !Number.isInteger(proCount) || proCount !== feed.predictions.length || proCount > 5
  || Number(feed.shortfall.pro) !== Math.max(0, 3 - proCount)) {
  console.error('publish-pro: quota metadata is inconsistent with 3–5 target');
  process.exit(1);
}
if (feed.predictions.length > 5 || feed.predictions.some(p => Number(p.confidence) < 60 || p.value !== true || p.odds == null)) {
  console.error('publish-pro: PRO feed must contain at most five qualified value predictions (confidence >= 60%)');
  process.exit(1);
}

const res = await fetch(`${url}/api/admin/pro-feed?key=${encodeURIComponent(key)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(feed),
  signal: AbortSignal.timeout(20000),
});

const body = await res.text();
if (!res.ok) {
  console.error(`publish-pro: HTTP ${res.status} — ${body.slice(0, 300)}`);
  process.exit(1);
}
const published = JSON.parse(body);
if (!published.ok || published.date !== feed.date || published.count !== feed.predictions.length) {
  console.error('publish-pro: подтверждение публикации не совпало с отправленным фидом');
  process.exit(1);
}
console.log(`publish-pro: OK — ${feed.predictions.length} VIP-прогнозов за ${feed.date} загружено в хранилище воркера`);
