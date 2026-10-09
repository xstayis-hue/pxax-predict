/* PXAXBET2016 AI — оплата Telegram Stars на Cloudflare Worker.
   Зачем не Node-сервер с туннелем: cloudflared-адрес меняется при каждом
   перезапуске, из-за этого оплата и триал «отваливались» (см. README). Воркер
   живёт на постоянном адресе *.workers.dev и не требует своей машины.

   Роуты:
     GET  /health                                  — готовность и наличие секретов
     GET  /api/status?uid=&initData=               — статус PRO, цена, история платежей
     GET  /api/pro?initData=                       — VIP-прогнозы: только подписчику
     POST /api/trial    {initData}                 — активировать бесплатные 3 дня
     POST /api/invoice  {initData}                 — ссылка на счёт Stars для tg.openInvoice
     POST /tg/<secret>                             — вебхук Telegram (счёт, оплата, /start)
     POST /api/admin/pro-feed?key=                 — залить свежий pro-feed.json (из CI)
     GET  /api/admin/pro-feed?key=&date=           — забрать фид (резолверу для сверки)

   Секреты (wrangler secret put): BOT_TOKEN, WEBHOOK_SECRET, ADMIN_KEY.
   Переменные (wrangler.toml [vars]): STARS_PRICE, PRO_DAYS, TRIAL_DAYS, MINIAPP_URL.
   Хранилище: KV (USERS) — по ключу u:<telegram_id> лежит запись пользователя,
   по ключу pro:<дата> — VIP-прогнозы дня (в публичный репозиторий не попадают). */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...cors() } });

// ---------- конфиг ----------
const config = (env) => ({
  token: env.BOT_TOKEN || '',
  webhookSecret: env.WEBHOOK_SECRET || '',
  adminKey: env.ADMIN_KEY || '',
  price: Number(env.STARS_PRICE) > 0 ? Math.round(Number(env.STARS_PRICE)) : 777,
  proDays: Number(env.PRO_DAYS) > 0 ? Math.round(Number(env.PRO_DAYS)) : 30,
  trialDays: Number(env.TRIAL_DAYS) >= 0 ? Math.round(Number(env.TRIAL_DAYS)) : 3,
  miniappUrl: env.MINIAPP_URL || '',
});

// ---------- Telegram API ----------
const tgApi = async (token, method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) console.warn('TG API error:', method, j.description);
  return j;
};

/* ---------- валидация initData (алгоритм Telegram) ----------
   secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)
   hash   = HMAC_SHA256(key=secret, msg=data_check_string) */
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const hmac = async (key, msg) => {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, msg);
};

export async function validateInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    params.delete('signature'); // подпись для сторонних платформ — не входит в data_check_string
    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const enc = new TextEncoder();
    const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
    const computed = toHex(await hmac(secret, enc.encode(dataCheckString)));
    if (computed.length !== hash.length) return null;
    // сравнение постоянного времени: иначе по времени ответа можно подбирать хеш
    let diff = 0;
    for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
    if (diff !== 0) return null;
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    // защита от переигранного initData: Telegram кладёт время выпуска в auth_date
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
    return user;
  } catch {
    return null;
  }
}

/* ---------- хранилище ----------
   Предпочитаем D1, KV — запасной вариант.

   Почему так: на free-плане у KV всего 1000 записей в сутки НА АККАУНТ, и этот
   лимит выбирает соседний проект (AI-компаньон PxAxAi постоянно пишет состояние,
   память и rate-limit). Факт с продакшена: 1201 запись за сутки при лимите 1000 —
   и оплата падала с «KV put() limit exceeded for the day». Для приёма денег это
   недопустимо: запись о платеже не должна зависеть от чужого трафика.
   У D1 лимиты на порядки выше (100 000 строк в сутки), поэтому платежи живут там.
   Если D1 не привязана — молча работаем на KV, чтобы воркер оставался совместимым. */
const TABLE_USERS = 'pxaxbet_users';
const TABLE_PRO = 'pxaxbet_pro';
const userKey = (uid) => `u:${uid}`;
const proKey = (date) => `pro:${date}`;
// Схему создаём один раз НА КОНКРЕТНУЮ БАЗУ, а не на изолят: в проде база одна,
// но в тестах каждый прогон поднимает свой D1, и общий флаг ломал бы второй тест.
const schemaReady = new WeakSet();

async function ensureSchema(env) {
  if (!env.DB || schemaReady.has(env.DB)) return;
  // D1 exec() выполняет каждую строку как отдельный стейтмент, поэтому DDL
  // пишем одной строкой — многострочный CREATE TABLE падает с «incomplete input»
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS ${TABLE_USERS} (uid TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS ${TABLE_PRO} (date TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  schemaReady.add(env.DB);
}

export const loadUser = async (env, uid) => {
  if (env.DB) {
    await ensureSchema(env);
    const row = await env.DB.prepare(`SELECT data FROM ${TABLE_USERS} WHERE uid = ?`).bind(String(uid)).first();
    if (!row || !row.data) return null;
    try { return JSON.parse(row.data); } catch { return null; }
  }
  return (await env.USERS.get(userKey(uid), 'json')) || null;
};

export const saveUser = async (env, uid, user) => {
  const payload = JSON.stringify(user);
  if (env.DB) {
    await ensureSchema(env);
    await env.DB.prepare(
      `INSERT INTO ${TABLE_USERS} (uid, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(String(uid), payload, new Date().toISOString()).run();
    return;
  }
  await env.USERS.put(userKey(uid), payload);
};

export const getProFeed = async (env, date) => {
  if (env.DB) {
    await ensureSchema(env);
    const row = await env.DB.prepare(`SELECT data FROM ${TABLE_PRO} WHERE date = ?`).bind(date).first();
    if (!row || !row.data) return null;
    try { return JSON.parse(row.data); } catch { return null; }
  }
  return env.USERS.get(proKey(date), 'json');
};

export const putProFeed = async (env, date, feed) => {
  const payload = JSON.stringify(feed);
  if (env.DB) {
    await ensureSchema(env);
    await env.DB.prepare(
      `INSERT INTO ${TABLE_PRO} (date, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(date, payload, new Date().toISOString()).run();
    return;
  }
  await env.USERS.put(proKey(date), payload);
};

// оставляем только нужные дни: и KV, и таблица не должны расти бесконечно
const pruneProFeed = async (env, keep) => {
  if (env.DB) {
    await ensureSchema(env);
    const marks = [...keep].map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM ${TABLE_PRO} WHERE date NOT IN (${marks})`).bind(...keep).run();
    return;
  }
  const list = await env.USERS.list({ prefix: 'pro:' });
  for (const k of list.keys) {
    if (!keep.has(k.name.slice('pro:'.length))) await env.USERS.delete(k.name);
  }
};

// список пользователей — для админ-сводки
const listUserIds = async (env) => {
  if (env.DB) {
    await ensureSchema(env);
    const res = await env.DB.prepare(`SELECT uid FROM ${TABLE_USERS}`).all();
    return (res.results || []).map(r => r.uid);
  }
  const list = await env.USERS.list({ prefix: 'u:', limit: 1000 });
  return list.keys.map(k => k.name.slice('u:'.length));
};

const isPro = (user) => !!(user && user.until && new Date(user.until) > new Date());

// новая дата окончания считается поверх действующей подписки
export const extendUntil = (user, days, now = new Date()) => {
  const base = user && user.until && new Date(user.until) > now ? new Date(user.until) : new Date(now);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString();
};

// платежи пользователя и отметка о подписке пишутся одной записью KV
export const applyPayment = (user, chargeId, stars, days, now = new Date()) => {
  const u = user ? { ...user } : {};
  u.charges = Array.isArray(u.charges) ? [...u.charges] : [];
  if (chargeId && u.charges.includes(chargeId)) return { user: u, changed: false };
  if (chargeId) u.charges.push(chargeId);
  if (u.charges.length > 50) u.charges = u.charges.slice(-50);
  u.until = extendUntil(u, days, now);
  u.payments = Array.isArray(u.payments) ? [...u.payments] : [];
  u.payments.push({ d: now.toISOString(), stars });
  if (u.payments.length > 30) u.payments = u.payments.slice(-30);
  return { user: u, changed: true };
};

/* ---------- счёт ---------- */
export const invoicePayload = (uid, nonce) => `pro_${uid}_${nonce}`;

const createInvoiceLink = async (cfg, uid) => {
  const nonce = crypto.randomUUID().slice(0, 8);
  return tgApi(cfg.token, 'createInvoiceLink', {
    title: `PRO-подписка PXAXBET2016 AI на ${cfg.proDays} дней`,
    description: `Доступ к VIP-прогнозам Pro-ИИ на ${cfg.proDays} дней. Оплата Stars — разовая, не автопродление.`,
    payload: invoicePayload(uid, nonce),
    currency: 'XTR',
    prices: [{ label: `PRO на ${cfg.proDays} дней`, amount: cfg.price }],
  });
};

const parsePayload = (payload) => {
  const m = /^pro_(\d+)_([a-z0-9-]{4,16})$/i.exec(String(payload || ''));
  return m ? { uid: m[1] } : null;
};

/* ---------- VIP-фид (прогнозы Pro-ИИ) ----------
   В публичный репозиторий не попадает: генератор пишет его в data/pro-feed.json
   (в .gitignore), CI заливает сюда админ-роутом, а подписчик забирает через
   /api/pro. Так VIP-контент не скачивается без подписки. */

async function handlePro(request, env, cfg) {
  if (!cfg.token) return json({ ok: false, error: 'not_configured' }, 503);
  const url = new URL(request.url);
  const initData = url.searchParams.get('initData') || request.headers.get('X-Telegram-Init-Data') || '';
  const user = await validateInitData(initData, cfg.token);
  if (!user) return json({ ok: false, error: 'bad_auth' }, 401);

  const stored = await loadUser(env, user.id);
  if (!isPro(stored)) return json({ ok: false, error: 'no_subscription', pro: false }, 403);

  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // день по МСК
  const feed = await getProFeed(env, today);
  if (!feed) return json({ ok: true, pro: true, date: today, count: 0, botd: null, predictions: [] });
  return json({ ok: true, pro: true, ...feed });
}

async function handleProFeedAdmin(request, env, cfg) {
  const url = new URL(request.url);
  if (!cfg.adminKey || url.searchParams.get('key') !== cfg.adminKey) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (request.method === 'GET') {
    const date = url.searchParams.get('date');
    if (!date) return json({ error: 'date_required' }, 400);
    const feed = await getProFeed(env, date);
    return json({ ok: true, date, feed: feed || null });
  }
  // POST — заливка фида генератором (из CI, ключом админа)
  const body = await request.json().catch(() => null);
  if (!body || !body.date || !Array.isArray(body.predictions)) {
    return json({ error: 'bad_feed' }, 400);
  }
  // в VIP-фиде не должно быть бесплатных прогнозов: иначе он утечёт целиком
  const leaked = body.predictions.filter(p => p.tier && p.tier !== 'pro');
  if (leaked.length) return json({ error: 'feed_contains_free' }, 400);

  await putProFeed(env, body.date, body);
  // чистим старые дни, чтобы хранилище не росло бесконечно (7 дней истории
  // достаточно для сверки результатов, дольше резолвер не смотрит)
  try {
    const keep = new Set();
    for (let i = 0; i < 7; i++) {
      keep.add(new Date(Date.now() + 3 * 3600e3 - i * 86400e3).toISOString().slice(0, 10));
    }
    await pruneProFeed(env, keep);
  } catch (e) { console.warn('pro-feed cleanup:', String(e)); }

  return json({ ok: true, date: body.date, count: body.predictions.length });
}

/* ---------- пользовательские роуты ---------- */
async function handleStatus(request, env, cfg) {
  const url = new URL(request.url);
  const uid = url.searchParams.get('uid') || '';
  const user = uid ? await loadUser(env, uid) : null;
  // историю платежей отдаём только владельцу: иначе статус любого uid перебирается
  const auth = await validateInitData(url.searchParams.get('initData') || '', cfg.token);
  const own = !!(auth && String(auth.id) === String(uid));
  return json({
    pro: isPro(user),
    until: (user && user.until) || null,
    price: cfg.price,
    days: cfg.proDays,
    trialDays: cfg.trialDays,
    trialUsed: !!(user && user.trial),
    payments: own && user && Array.isArray(user.payments) ? user.payments : [],
  });
}

async function handleTrial(request, env, cfg) {
  if (!cfg.token) return json({ ok: false, error: 'not_configured' }, 503);
  const body = await request.json().catch(() => ({}));
  const user = await validateInitData(body.initData, cfg.token);
  if (!user) return json({ ok: false, error: 'bad_auth' }, 401);

  const stored = await loadUser(env, user.id);
  if (isPro(stored)) return json({ ok: false, reason: 'active' });
  if (stored && stored.trial) return json({ ok: false, reason: 'used' });
  if (cfg.trialDays <= 0) return json({ ok: false, reason: 'disabled' });

  const next = {
    ...(stored || {}),
    trial: true,
    name: user.first_name || (stored && stored.name) || '',
    until: extendUntil(stored, cfg.trialDays),
  };
  await saveUser(env, user.id, next);
  return json({ ok: true, until: next.until, days: cfg.trialDays });
}

async function handleInvoice(request, env, cfg) {
  if (!cfg.token) return json({ ok: false, error: 'not_configured' }, 503);
  const body = await request.json().catch(() => ({}));
  const user = await validateInitData(body.initData, cfg.token);
  if (!user) return json({ ok: false, error: 'bad_auth' }, 401);

  const inv = await createInvoiceLink(cfg, user.id);
  if (!inv.ok || !inv.result) return json({ ok: false, error: 'invoice_failed' }, 502);
  const stored = await loadUser(env, user.id);
  await saveUser(env, user.id, { ...(stored || {}), name: user.first_name || (stored && stored.name) || '' });
  return json({ ok: true, invoiceUrl: inv.result, price: cfg.price, days: cfg.proDays });
}

/* ---------- вебхук Telegram ---------- */
async function handleWebhook(request, env, cfg, secretFromPath) {
  if (!cfg.token || !cfg.webhookSecret) return new Response('not configured', { status: 503 });
  // секрет приходит и в заголовке (его ставит Telegram), и в пути — путь нужен,
  // потому что URL вебхука должен быть непредсказуемым
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (secretFromPath !== cfg.webhookSecret && header !== cfg.webhookSecret) {
    return new Response('forbidden', { status: 403 });
  }

  const update = await request.json().catch(() => null);
  if (!update) return new Response('bad update', { status: 400 });

  // 1) подтверждение оплаты до списания: принимаем только свои payload и суммы
  const pcq = update.pre_checkout_query;
  if (pcq) {
    const parsed = parsePayload(pcq.invoice_payload);
    const ok =
      !!parsed &&
      pcq.currency === 'XTR' &&
      Number(pcq.total_amount) === cfg.price;
    await tgApi(cfg.token, 'answerPreCheckoutQuery', {
      pre_checkout_query_id: pcq.id,
      ok,
      ...(ok ? {} : { error_message: 'Счёт устарел — оформите подписку заново.' }),
    });
    return new Response('ok');
  }

  const msg = update.message;
  if (!msg) return new Response('ok');

  // 2) успешная оплата: идемпотентно продлеваем доступ
  const pay = msg.successful_payment;
  if (pay) {
    const parsed = parsePayload(pay.invoice_payload);
    const chatId = msg.chat && msg.chat.id;
    const amount = Number(pay.total_amount);
    if (!parsed || pay.currency !== 'XTR' || amount !== cfg.price) {
      console.error('payment does not match an order', pay.invoice_payload, amount);
      return new Response('ok');
    }
    const stored = await loadUser(env, chatId);
    const { user: next, changed } = applyPayment(stored, pay.telegram_payment_charge_id, amount, cfg.proDays);
    if (changed) {
      await saveUser(env, chatId, next);
      await tgApi(cfg.token, 'sendMessage', {
        chat_id: chatId,
        text: `💎 PRO активирована до ${new Date(next.until).toLocaleDateString('ru-RU')}!\nОткрой приложение заново — статус обновится.\n\n_Прогнозы не гарантируют результат, 18+_`,
        parse_mode: 'Markdown',
      });
    }
    return new Response('ok');
  }

  // 3) команды
  const text = String(msg.text || '');
  const chatId = msg.chat && msg.chat.id;
  const kb = cfg.miniappUrl
    ? { inline_keyboard: [[{ text: '⚡ Открыть приложение', web_app: { url: cfg.miniappUrl } }]] }
    : undefined;
  if (text.startsWith('/start')) {
    await tgApi(cfg.token, 'sendMessage', {
      chat_id: chatId,
      text: `👋 Привет!\n\n⚡ PXAXBET2016 AI — ИИ-прогнозы на спорт каждый день.\nЖми «Открыть приложение»${cfg.miniappUrl ? '' : ' или /subscribe'} — прогнозы и оплата уже там.\n\n⚠️ Прогнозы делает ИИ, это не 100% вероятность. 18+`,
      reply_markup: kb,
    });
  } else if (text.startsWith('/subscribe')) {
    const inv = await tgApi(cfg.token, 'sendInvoice', {
      chat_id: chatId,
      title: `PRO-подписка PXAXBET2016 AI на ${cfg.proDays} дней`,
      description: `Доступ к VIP-прогнозам Pro-ИИ на ${cfg.proDays} дней`,
      payload: invoicePayload(chatId, crypto.randomUUID().slice(0, 8)),
      currency: 'XTR',
      prices: [{ label: `PRO на ${cfg.proDays} дней`, amount: cfg.price }],
    });
    if (!inv.ok) {
      await tgApi(cfg.token, 'sendMessage', { chat_id: chatId, text: '⚠️ Не удалось выставить счёт. Попробуй позже.' });
    }
  } else if (text.startsWith('/paysupport')) {
    await tgApi(cfg.token, 'sendMessage', {
      chat_id: chatId,
      text: 'По вопросам оплаты и возврата Stars напиши в поддержку: @pxax_support',
    });
  }
  return new Response('ok');
}

// ---------- точка входа ----------
export default {
  async fetch(request, env) {
    const cfg = config(env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

    if (url.pathname === '/health') {
      return json({
        ok: true,
        ready: Boolean(cfg.token && cfg.webhookSecret),
        bot: Boolean(cfg.token),
        price: cfg.price,
        days: cfg.proDays,
        storage: env.DB ? 'd1' : (env.USERS ? 'kv' : 'none'),
      });
    }
    if (url.pathname === '/api/status' && request.method === 'GET') return handleStatus(request, env, cfg);
    if (url.pathname === '/api/pro' && request.method === 'GET') return handlePro(request, env, cfg);
    if (url.pathname === '/api/trial' && request.method === 'POST') return handleTrial(request, env, cfg);
    if (url.pathname === '/api/invoice' && request.method === 'POST') return handleInvoice(request, env, cfg);
    if (url.pathname === '/api/admin/pro-feed' && (request.method === 'GET' || request.method === 'POST')) {
      return handleProFeedAdmin(request, env, cfg);
    }
    if (url.pathname.startsWith('/tg/') && request.method === 'POST') {
      return handleWebhook(request, env, cfg, url.pathname.slice('/tg/'.length));
    }
    // админ: сколько людей с активной подпиской (нужен ADMIN_KEY)
    if (url.pathname === '/api/admin/stats' && request.method === 'GET') {
      if (!cfg.adminKey || url.searchParams.get('key') !== cfg.adminKey) {
        return json({ error: 'unauthorized' }, 401);
      }
      const ids = await listUserIds(env);
      let pro = 0, trial = 0;
      for (const uid of ids) {
        const u = await loadUser(env, uid);
        if (!u) continue;
        if (isPro(u)) pro++;
        if (u.trial) trial++;
      }
      return json({ users: ids.length, pro, trialUsed: trial, storage: env.DB ? 'd1' : 'kv' });
    }
    return json({ error: 'not_found' }, 404);
  },
};
