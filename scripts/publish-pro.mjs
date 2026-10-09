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
  console.log('publish-pro: PXAX_WORKER_URL/PXAX_ADMIN_KEY не заданы — VIP-фид не публикуется');
  console.log('(в CI это значит, что секреты не настроены; локально — что воркер не подключён)');
  process.exit(0); // не валим пайплайн: генерация данных важнее публикации
}
if (!existsSync(file)) {
  console.log(`publish-pro: ${file} нет — публиковать нечего`);
  process.exit(0);
}

const feed = JSON.parse(readFileSync(file, 'utf8'));
if (!feed.date || !Array.isArray(feed.predictions)) {
  console.error('publish-pro: в фиде нет date/predictions');
  process.exit(1);
}
// страховка от утечки: в VIP-фиде не должно быть бесплатных прогнозов
const leaked = feed.predictions.filter((p) => p.tier && p.tier !== 'pro');
if (leaked.length) {
  console.error(`publish-pro: в фиде ${leaked.length} не-PRO прогнозов — не публикую`);
  process.exit(1);
}

const res = await fetch(`${url}/api/admin/pro-feed?key=${encodeURIComponent(key)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(feed),
});

const body = await res.text();
if (!res.ok) {
  console.error(`publish-pro: HTTP ${res.status} — ${body.slice(0, 300)}`);
  process.exit(1);
}
console.log(`publish-pro: OK — ${feed.predictions.length} VIP-прогнозов за ${feed.date} загружено в хранилище воркера`);
