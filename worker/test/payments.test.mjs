/* Тесты воркера оплаты: подпись initData, идемпотентность платежа,
   начисление срока, триал. Запуск: node worker/test/payments.test.mjs */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const BOT_TOKEN = '123456:TEST-TOKEN';
process.env.TZ = 'UTC';

// KV-заглушка в памяти
function makeKV() {
  const m = new Map();
  return {
    async get(k, type) { const v = m.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async list({ prefix = '' } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    _map: m,
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

const call = (worker, request, e) => worker.fetch(request, e);

const post = (path, body, headers = {}) =>
  new Request('https://px.example.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const mod = await import('../src/index.js');
const worker = mod.default;

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

await test('валидный initData принимается, подделанный — нет', async () => {
  const e = env();
  const good = initDataFor(555);
  const r1 = await call(worker, post('/api/trial', { initData: good }), e);
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).ok, true);

  const tampered = good.replace('auth_date', 'auth_dat3');
  const r2 = await call(worker, post('/api/trial', { initData: tampered }), env());
  assert.equal(r2.status, 401);
});

await test('initData старше суток отклоняется', async () => {
  const old = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000) - 90000),
    user: JSON.stringify({ id: 777, first_name: 'Старый' }),
  });
  const r = await call(worker, post('/api/trial', { initData: old }), env());
  assert.equal(r.status, 401);
});

await test('повторный триал не выдаётся: активный PRO и уже использованный триал', async () => {
  const e = env();
  const d = initDataFor(1001);
  const first = await (await call(worker, post('/api/trial', { initData: d }), e)).json();
  assert.equal(first.ok, true);
  // пока триал действует, пользователь уже PRO — второй раз не начисляем
  const again = await (await call(worker, post('/api/trial', { initData: d }), e)).json();
  assert.equal(again.reason, 'active');
  // после истечения триала флаг trial не даёт взять его снова
  const u = await e.USERS.get('u:1001', 'json');
  u.until = new Date(Date.now() - 86400000).toISOString();
  await e.USERS.put('u:1001', JSON.stringify(u));
  const expired = await (await call(worker, post('/api/trial', { initData: d }), e)).json();
  assert.equal(expired.reason, 'used');
});

await test('статус отдаёт pro/until/цену, чужой uid не видит историю платежей', async () => {
  const e = env();
  await call(worker, post('/api/trial', { initData: initDataFor(2002) }), e);
  const own = new URL('https://px.example.test/api/status');
  own.searchParams.set('uid', '2002');
  own.searchParams.set('initData', initDataFor(2002));
  const j1 = await (await call(worker, new Request(own), e)).json();
  assert.equal(j1.pro, true);
  assert.equal(j1.price, 777);

  const other = new URL('https://px.example.test/api/status');
  other.searchParams.set('uid', '2002');
  other.searchParams.set('initData', initDataFor(9999));
  const j2 = await (await call(worker, new Request(other), e)).json();
  assert.equal(j2.pro, true);
  assert.deepEqual(j2.payments, []);
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
  const u1 = await e.USERS.get('u:3003', 'json');
  assert.ok(u1 && u1.until, 'срок должен появиться');
  const days = (new Date(u1.until) - Date.now()) / 86400000;
  assert.ok(days > 29 && days < 31, 'срок около 30 дней, получено ' + days);

  // повторный тот же апдейт (после ретрая Telegram) не продлевает второй раз
  await call(worker, req(), e);
  const u2 = await e.USERS.get('u:3003', 'json');
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
  assert.equal(await e.USERS.get('u:4004', 'json'), null);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
