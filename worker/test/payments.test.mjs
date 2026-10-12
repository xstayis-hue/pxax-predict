/* Тесты воркера оплаты: подпись initData, идемпотентность платежа,
   начисление срока, триал, VIP-фид. Запуск: node worker/test/payments.test.mjs */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const BOT_TOKEN = '123456:TEST-TOKEN';
process.env.TZ = 'UTC';

// KV-заглушка в памяти
function makeKV() {
  const m = new Map();
  return {
    async get(k, type) { const v = m.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    _map: m,
  };
}

/* D1-заглушка на node:sqlite: повторяет тот узкий интерфейс, которым пользуется
   воркер (exec / prepare().bind().run() / .first() / .all()). Так тесты гоняют
   именно продовый путь — на D1, а не на запасном KV.

   Важная деталь: настоящий D1 exec() разбивает вход по строкам и выполняет каждую
   отдельно, поэтому многострочный CREATE TABLE падает с «incomplete input».
   Заглушка ведёт себя так же — иначе эта ошибка прошла бы мимо тестов и всплыла
   только в проде (так и случилось). */
function makeD1() {
  const db = new DatabaseSync(':memory:');
  const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
  return {
    async exec(sql) {
      for (const line of String(sql).split('\n')) {
        const stmt = line.trim();
        if (stmt) db.exec(stmt);
      }
    },
    prepare(sql) {
      const stmt = db.prepare(norm(sql));
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() { return stmt.run(...args); },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
      };
      return api;
    },
    _db: db,
  };
}

// подпись initData ровно как у Telegram
function signInitData(fields, botToken = BOT_TOKEN) {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

const initDataFor = (id, extra = {}) =>
  signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA' + id, ...extra, user: JSON.stringify({ id, first_name: 'Тест', username: 'test' }) });

const env = (over = {}) => ({
  BOT_TOKEN,
  WEBHOOK_SECRET: 'webhook-secret-32-characters-long',
  ADMIN_KEY: 'admin-key',
  STARS_PRICE: '777',
  PRO_DAYS: '30',
  TRIAL_DAYS: '3',
  MINIAPP_URL: 'https://example.test/app',
  USERS: makeKV(),
  ...over,
});
// то же окружение, но с D1 — как в проде
const envD1 = (over = {}) => env({ DB: makeD1(), ...over });

const call = (worker, request, e) => worker.fetch(request, e);


const post = (path, body, headers = {}) =>
  new Request('https://px.example.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const mod = await import('../src/index.js');
const worker = mod.default;
// доступ к хранилищу через те же хелперы, что использует воркер: тест не знает,
// D1 внутри или KV, и одинаково проходит на обоих
const { loadUser: getU, saveUser: putU, getProFeed: getFeed, putProFeed: putFeed } = mod;

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e && e.message)); }
};

console.log('worker/payments');

await test('health отдаёт цену и сроки из vars', async () => {
  const r = await call(worker, new Request('https://px.example.test/health'), env());
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.price, 777);
  assert.equal(j.days, 30);
  assert.equal(j.ready, true);
});

/* Telegram принимает title счёта длиной 1–32 символа. Заголовок
   «PRO-подписка PXAXBET2016 AI на 30 дней» — 38 символов, из-за чего
   createInvoiceLink отвечал ok:false и оплата падала с «Не удалось выставить
   счёт». Тест держит лимит: смена названия или PRO_DAYS не должна его пробить. */
await test('заголовок счёта укладывается в лимит Telegram (32 символа)', async () => {
  const { invoiceTitle } = mod;
  for (const days of [3, 30, 90, 365, 1000]) {
    const t = invoiceTitle(days);
    assert.ok(t.length >= 1 && t.length <= 32, `title ${days} дн. = ${t.length} символов: ${t}`);
    assert.ok(t.includes(String(days)), `в заголовке нет срока: ${t}`);
  }
});

await test('единый контракт initData проходит CORS и поддерживается оплатой/триалом', async () => {
  const e = env();
  const preflight = await call(worker, new Request('https://px.example.test/api/invoice', {
    method: 'OPTIONS',
    headers: { Origin: 'https://app.example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-telegram-init-data' },
  }), e);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers') || '', /X-Telegram-Init-Data/i);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: 'https://t.me/invoice/test' }), { headers: { 'Content-Type': 'application/json' } });
  try {
    const invoice = await call(worker, post('/api/invoice', {}, { 'X-Telegram-Init-Data': initDataFor(2222) }), e);
    assert.equal(invoice.status, 200);
  } finally { globalThis.fetch = realFetch; }
  const trial = await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': initDataFor(2223) }), e);
  assert.equal(trial.status, 200);
  const oldBodyContract = await call(worker, post('/api/trial', { initData: initDataFor(2224) }), e);
  assert.equal(oldBodyContract.status, 401);
});

await test('createInvoiceLink получает короткий заголовок и Stars-цену', async () => {
  const e = env();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), method: String(url).split('/').pop(), body });
    // отвечаем как Telegram на createInvoiceLink
    if (String(url).endsWith('/createInvoiceLink')) return new Response(JSON.stringify({ ok: true, result: 'https://t.me/invoice/test' }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const r = await call(worker, post('/api/invoice', {}, { 'X-Telegram-Init-Data': initDataFor(9301) }), e);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.ok, true);
    assert.equal(j.invoiceUrl, 'https://t.me/invoice/test');
    const inv = calls.find(c => c.method === 'createInvoiceLink');
    assert.ok(inv, 'createInvoiceLink не вызывался');
    assert.equal(inv.body.currency, 'XTR');
    assert.equal(inv.body.provider_token, '', 'для Stars provider_token должен быть пустой строкой');
    assert.ok(inv.body.title.length <= 32, `title ${inv.body.title.length} символов`);
    assert.equal(inv.body.prices.length, 1);
    assert.equal(inv.body.prices[0].amount, 777);
    assert.ok(Buffer.byteLength(inv.body.payload) <= 128, 'payload больше 128 байт');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('если Telegram отверг счёт — воркер отдаёт invoice_failed', async () => {
  const e = env();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: TITLE_TOO_LONG' }), { headers: { 'Content-Type': 'application/json' } });
  try {
    const r = await call(worker, post('/api/invoice', {}, { 'X-Telegram-Init-Data': initDataFor(9302) }), e);
    const j = await r.json();
    assert.equal(r.status, 502);
    assert.equal(j.error, 'invoice_failed');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('валидный initData принимается, подделанный — нет', async () => {
  const e = env();
  const good = initDataFor(555);
  const r1 = await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': good }), e);
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).ok, true);

  const tampered = good.replace('auth_date', 'auth_dat3');
  const r2 = await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': tampered }), env());
  assert.equal(r2.status, 401);
});

/* Регрессия «Сессия устарела» на любой оплате: Telegram с 2024 кладёт в initData
   поле signature, и оно ВХОДИТ в data_check_string для hash. Пока воркер его
   вырезал, хеш не сходился никогда — ни один счёт не выставлялся, и переоткрытие
   приложения не помогало. Тест берёт initData СО signature (как приходит из
   Telegram) и требует, чтобы подпись принималась. */
await test('initData с полем signature принимается (hash покрывает signature)', async () => {
  const e = env();
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat_instance: '1234567890123456789',
    chat_type: 'private',
    signature: 'Zm9vYmFyLXNpZ25hdHVyZS1iYXNlNjR1cmwtZXhhbXBsZQ',
    user: JSON.stringify({ id: 9310, first_name: 'Тест', username: 'test' }),
  };
  const unsigned = new URLSearchParams(fields);
  const dcs = [...unsigned.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  unsigned.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  const withSig = unsigned.toString();

  const r = await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': withSig }), e);
  const j = await r.json();
  assert.equal(r.status, 200, `signature-подпись должна приниматься: ${JSON.stringify(j)}`);
  assert.equal(j.ok, true);
});

await test('initData без signature тоже принимается (старые клиенты)', async () => {
  const e = env();
  const r = await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': initDataFor(9311) }), e);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

await test('initData старше суток отклоняется', async () => {
  const old = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000) - 90000),
    user: JSON.stringify({ id: 777, first_name: 'Старый' }),
  });
  const r = await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': old }), env());
  assert.equal(r.status, 401);
});

await test('повторный триал не выдаётся: активный PRO и уже использованный триал', async () => {
  const e = env();
  const d = initDataFor(1001);
  const first = await (await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': d }), e)).json();
  assert.equal(first.ok, true);
  // пока триал действует, пользователь уже PRO — второй раз не начисляем
  const again = await (await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': d }), e)).json();
  assert.equal(again.reason, 'active');
  // после истечения триала флаг trial не даёт взять его снова
  const u = await getU(e, 1001);
  u.until = new Date(Date.now() - 86400000).toISOString();
  await putU(e, 1001, u);
  const expired = await (await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': d }), e)).json();
  assert.equal(expired.reason, 'used');
});

await test('статус отдаёт pro/until/цену, чужой uid не видит историю платежей', async () => {
  const e = env();
  await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': initDataFor(2002) }), e);
  const own = new URL('https://px.example.test/api/status?uid=2002');
  const j1 = await (await call(worker, new Request(own, { headers: { 'X-Telegram-Init-Data': initDataFor(2002) } }), e)).json();
  assert.equal(j1.pro, true);
  assert.equal(j1.price, 777);

  const other = new URL('https://px.example.test/api/status?uid=2002');
  const j2 = await (await call(worker, new Request(other, { headers: { 'X-Telegram-Init-Data': initDataFor(9999) } }), e)).json();
  assert.equal(j2.pro, true);
  assert.deepEqual(j2.payments, []);
});

await test('pre-checkout сверяет плательщика с владельцем invoice', async () => {
  const e = env();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const update = {
      pre_checkout_query: {
        id: 'pcq-1', from: { id: 5005 }, currency: 'XTR', total_amount: 777,
        invoice_payload: 'pro_5004_abcdef12',
      },
    };
    await call(worker, new Request('https://px.example.test/tg/' + e.WEBHOOK_SECRET, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update),
    }), e);
    const answer = calls.find(c => c.method === 'answerPreCheckoutQuery')?.body;
    assert.equal(answer?.ok, false);
  } finally { globalThis.fetch = realFetch; }
});

await test('оплата отклоняется, если владелец invoice не совпадает с плательщиком', async () => {
  const e = env();
  const body = {
    update_id: 3,
    message: {
      chat: { id: 4005 }, from: { id: 4005 },
      successful_payment: { currency: 'XTR', total_amount: 777, invoice_payload: 'pro_4004_abcdef12', telegram_payment_charge_id: 'charge-owner-mismatch' },
    },
  };
  const r = await call(worker, new Request('https://px.example.test/tg/' + e.WEBHOOK_SECRET, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), e);
  assert.equal(r.status, 200);
  assert.equal(await getU(e, 4004), null);
  assert.equal(await getU(e, 4005), null);
});

await test('успешная оплата продлевает срок и не повторяется', async () => {
  const e = env();
  const body = {
    update_id: 1,
    message: {
      chat: { id: 3003 },
      from: { id: 3003, first_name: 'Плат' },
      successful_payment: {
        currency: 'XTR', total_amount: 777,
        invoice_payload: 'pro_3003_abcdef12',
        telegram_payment_charge_id: 'charge-1',
      },
    },
  };
  const req = () => new Request('https://px.example.test/tg/' + e.WEBHOOK_SECRET, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await call(worker, req(), e);
  const u1 = await getU(e, 3003);
  assert.ok(u1 && u1.until, 'срок должен появиться');
  const days = (new Date(u1.until) - Date.now()) / 86400000;
  assert.ok(days > 29 && days < 31, 'срок около 30 дней, получено ' + days);

  // повторный тот же апдейт (после ретрая Telegram) не продлевает второй раз
  await call(worker, req(), e);
  const u2 = await getU(e, 3003);
  assert.equal(u2.until, u1.until);
  assert.equal(u2.payments.length, 1);
});

await test('оплата с чужой суммой не начисляется', async () => {
  const e = env();
  const body = {
    update_id: 2,
    message: {
      chat: { id: 4004 }, from: { id: 4004 },
      successful_payment: { currency: 'XTR', total_amount: 1, invoice_payload: 'pro_4004_zzzz1111', telegram_payment_charge_id: 'charge-bad' },
    },
  };
  await call(worker, new Request('https://px.example.test/tg/' + e.WEBHOOK_SECRET, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), e);
  assert.equal(await getU(e, 4004), null);
});

await test('вебхук без секрета отклоняется', async () => {
  const e = env();
  const r = await call(worker, new Request('https://px.example.test/tg/wrong-secret', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }), e);
  assert.equal(r.status, 403);
});

await test('админ-сводка требует ключ', async () => {
  const e = env();
  const r1 = await call(worker, new Request('https://px.example.test/api/admin/stats'), e);
  assert.equal(r1.status, 401);
  const r2 = await call(worker, new Request('https://px.example.test/api/admin/stats?key=admin-key'), e);
  const j = await r2.json();
  assert.equal(typeof j.users, 'number');
});

/* ---------- VIP-фид: главное — без подписки прогнозы не отдаются ---------- */

const todayMsk = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const quotaMeta = (count, freeCount = 0) => ({ targets: { free: 3, pro: 3 }, shortfall: { free: Math.max(0, 3 - freeCount), pro: Math.max(0, 3 - count) } });

await test('VIP-фид не отдаётся без подписки и без валидного initData', async () => {
  const e = env();
  // кладём фид так, как это делает CI
  const feed = { date: todayMsk(), generated: new Date().toISOString(), count: 1, ...quotaMeta(1), predictions: [{ id: '1', market: 'П1', tier: 'pro', confidence: 65, value: true }], botd: null };
  await putFeed(e, todayMsk(), feed);

  // без initData
  const r1 = await call(worker, new Request('https://px.example.test/api/pro'), e);
  assert.equal(r1.status, 401);

  // с валидным initData, но без подписки
  const r2 = await call(worker, new Request('https://px.example.test/api/pro', { headers: { 'X-Telegram-Init-Data': initDataFor(6001) } }), e);
  assert.equal(r2.status, 403);
  assert.equal((await r2.json()).error, 'no_subscription');

  // подписки нет, и в ответе нет ни одного прогноза
  const text = await (await call(worker, new Request('https://px.example.test/api/pro', { headers: { 'X-Telegram-Init-Data': initDataFor(6001) } }), e)).text();
  assert.ok(!text.includes('П1'), 'в отказе не должно быть данных фида');
});

await test('VIP-фид отдаётся подписчику', async () => {
  const e = env();
  const feed = { date: todayMsk(), generated: new Date().toISOString(), count: 1, ...quotaMeta(1), predictions: [{ id: '2', market: 'ТБ 2.5', tier: 'pro', confidence: 65, value: true }], botd: { legs: [1, 2] } };
  await putFeed(e, todayMsk(), feed);
  // сначала активируем подписку тем же пользователем
  await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': initDataFor(6002) }), e);

  const r = await call(worker, new Request('https://px.example.test/api/pro', { headers: { 'X-Telegram-Init-Data': initDataFor(6002) } }), e);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.predictions.length, 1);
  assert.equal(j.predictions[0].market, 'ТБ 2.5');
  assert.deepEqual(j.botd, { legs: [1, 2] });
});

await test('PRO feed reports unavailable and stale data instead of empty success', async () => {
  const e = env();
  const init = initDataFor(6500);
  const missing = await call(worker, new Request('https://px.example.test/api/pro', { headers: { 'X-Telegram-Init-Data': init } }), e);
  assert.equal(missing.status, 403);
  await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': init }), e);
  const absent = await call(worker, new Request('https://px.example.test/api/pro', { headers: { 'X-Telegram-Init-Data': init } }), e);
  assert.equal(absent.status, 503);
  assert.equal((await absent.json()).error, 'feed_unavailable');
  const yesterday = new Date(Date.now() + 3 * 3600e3 - 86400e3).toISOString().slice(0, 10);
  await putFeed(e, yesterday, { date: yesterday, generated: new Date().toISOString(), count: 1, ...quotaMeta(1), predictions: [{ id: 'yesterday-live', tier: 'pro', confidence: 65, value: true }] });
  const grace = await call(worker, new Request('https://px.example.test/api/pro', { headers: { 'X-Telegram-Init-Data': init } }), e);
  assert.equal(grace.status, 200);
  const graceBody = await grace.json();
  assert.equal(graceBody.freshness, 'grace');
  assert.equal(graceBody.predictions[0].id, 'yesterday-live');

  const stale = await call(worker, post('/api/admin/pro-feed?key=admin-key', { date: yesterday, generated: new Date(Date.now() - 9 * 3600e3).toISOString(), predictions: [] }), e);
  assert.equal(stale.status, 400);

  await putFeed(e, yesterday, { date: yesterday, generated: new Date(Date.now() - 9 * 3600e3).toISOString(), predictions: [] });
  const staleRead = await call(worker, new Request('https://px.example.test/api/pro', { headers: { 'X-Telegram-Init-Data': init } }), e);
  assert.equal(staleRead.status, 503);
  assert.equal((await staleRead.json()).error, 'feed_stale');
});

await test('VIP auth принимается только из заголовка, query string не поддерживается', async () => {
  const e = env();
  await putFeed(e, todayMsk(), { date: todayMsk(), generated: new Date().toISOString(), predictions: [{ id: 'header-only', tier: 'pro', confidence: 65, value: true }] });
  const r = await call(worker, new Request('https://px.example.test/api/pro?initData=' + encodeURIComponent(initDataFor(6999))), e);
  assert.equal(r.status, 401);
});

await test('залить фид можно только с админ-ключом, и только PRO-прогнозы', async () => {
  const e = env();
  const url = 'https://px.example.test/api/admin/pro-feed?key=admin-key';
  const good = { date: todayMsk(), generated: new Date().toISOString(), count: 1, ...quotaMeta(1), predictions: [{ id: '3', tier: 'pro', confidence: 65, value: true }] };

  const noKey = await call(worker, new Request('https://px.example.test/api/admin/pro-feed?key=wrong', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(good),
  }), e);
  assert.equal(noKey.status, 401);

  const post = (body) => new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const duplicateId = await call(worker, post({ date: todayMsk(), generated: new Date().toISOString(), ...quotaMeta(2), predictions: [{ id: 'same', tier: 'pro' }, { id: 'same', tier: 'pro' }, { id: 'third', tier: 'pro' }] }), e);
  assert.equal(duplicateId.status, 400);
  assert.equal((await duplicateId.json()).error, 'duplicate_prediction_ids');
  const staleDay = await call(worker, post({ date: new Date(Date.now() + 3 * 3600e3 - 2 * 86400e3).toISOString().slice(0, 10), generated: new Date().toISOString(), predictions: [] }), e);
  assert.equal(staleDay.status, 400);

  const ok = await call(worker, post(good), e);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).count, 1);

  // фид с бесплатным прогнозом не принимаем: иначе VIP-файл утечёт целиком
  const bad = await call(worker, post({ date: todayMsk(), generated: new Date().toISOString(), ...quotaMeta(1), predictions: [{ id: '4', tier: 'free', confidence: 65, value: true }] }), e);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'feed_contains_free');

  // прочитать фид админом можно
  const get = await call(worker, new Request(`https://px.example.test/api/admin/pro-feed?key=admin-key&date=${todayMsk()}`), e);
  const gj = await get.json();
  assert.equal(gj.feed.predictions[0].id, '3');
});

await test('без подписки /api/pro не отдаёт даже число прогнозов', async () => {
  const e = env();
  await putFeed(e, todayMsk(), { date: todayMsk(), generated: new Date().toISOString(), count: 2, ...quotaMeta(2), predictions: [{ id: '5', tier: 'pro', confidence: 65, value: true }, { id: '6', tier: 'pro', confidence: 65, value: true }] });
  const r = await call(worker, new Request('https://px.example.test/api/pro', { headers: { 'X-Telegram-Init-Data': initDataFor(6003) } }), e);
  const body = await r.text();
  assert.equal(r.status, 403);
  assert.ok(!/predictions/.test(body), 'отказ не должен содержать поле predictions');
});

/* ---------- тот же набор на D1: в проде хранилище именно такое ---------- */

await test('D1: триал, оплата и VIP-фид работают на D1-хранилище', async () => {
  const e = envD1();
  // health должен сказать, что работает D1, а не KV
  const h = await (await call(worker, new Request('https://px.example.test/health'), e)).json();
  assert.equal(h.storage, 'd1');

  // триал пишется и читается
  const d = initDataFor(7101);
  const tr = await (await call(worker, post('/api/trial', {}, { 'X-Telegram-Init-Data': d }), e)).json();
  assert.equal(tr.ok, true);
  const st = await (await call(worker, new Request('https://px.example.test/api/status?uid=7101', { headers: { 'X-Telegram-Init-Data': d } }), e)).json();
  assert.equal(st.pro, true);
  assert.equal(st.trialUsed, true);

  // оплата продлевает и не дублируется
  const pay = {
    update_id: 11,
    message: {
      chat: { id: 7101 }, from: { id: 7101 },
      successful_payment: { currency: 'XTR', total_amount: 777, invoice_payload: 'pro_7101_aaaa1111', telegram_payment_charge_id: 'd1-charge-1' },
    },
  };
  const req = () => new Request('https://px.example.test/tg/' + e.WEBHOOK_SECRET, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pay),
  });
  await call(worker, req(), e);
  const u1 = await getU(e, 7101);
  await call(worker, req(), e);
  const u2 = await getU(e, 7101);
  assert.equal(u2.until, u1.until, 'повторный апдейт не продлевает второй раз');
  assert.equal(u2.payments.length, 1);

  // VIP-фид: кладём и достаём подписчиком
  await putFeed(e, todayMsk(), { date: todayMsk(), generated: new Date().toISOString(), count: 1, ...quotaMeta(1), predictions: [{ id: '9', market: 'Х2', tier: 'pro', confidence: 65, value: true }] });
  const got = await (await call(worker, new Request('https://px.example.test/api/pro', { headers: { 'X-Telegram-Init-Data': d } }), e)).json();
  assert.equal(got.ok, true);
  assert.equal(got.predictions[0].id, '9');
});

await test('D1: VIP-фид по-прежнему закрыт для неподписчика', async () => {
  const e = envD1();
  await putFeed(e, todayMsk(), { date: todayMsk(), generated: new Date().toISOString(), count: 1, ...quotaMeta(1), predictions: [{ id: '10', market: 'П1', tier: 'pro', confidence: 65, value: true }] });
  const r = await call(worker, new Request('https://px.example.test/api/pro', { headers: { 'X-Telegram-Init-Data': initDataFor(7202) } }), e);
  assert.equal(r.status, 403);
});

await test('D1: старые дни фида вычищаются, свежие остаются', async () => {
  const e = envD1();
  const day = (n) => new Date(Date.now() + 3 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
  await putFeed(e, day(0), { date: day(0), generated: new Date().toISOString(), predictions: [{ id: 'today', tier: 'pro', confidence: 65, value: true }] });
  await putFeed(e, day(20), { date: day(20), predictions: [{ id: 'old', tier: 'pro' }] });
  // заливка нового дня запускает уборку
  const url = 'https://px.example.test/api/admin/pro-feed?key=admin-key';
  await call(worker, new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: day(1), generated: new Date().toISOString(), targets: { free: 3, pro: 3 }, shortfall: { free: 0, pro: 2 }, predictions: [{ id: 'yesterday', tier: 'pro', confidence: 65, value: true }] }),
  }), e);
  assert.ok(await getFeed(e, day(0)), 'сегодняшний фид должен остаться');
  assert.ok(await getFeed(e, day(1)), 'вчерашний фид должен остаться');
  assert.equal(await getFeed(e, day(20)), null, 'старый фид должен быть удалён');
});

console.log(`\n${passed} passed, ${failed} failed`);
// exitCode, а не process.exit(): у node:sqlite открытые дескрипторы при жёстком
// выходе дают ложное предупреждение libuv на Windows
process.exitCode = failed ? 1 : 0;
