// PXAX 2016 AI — бэкенд подписки через Telegram Stars
// Node >= 18, без зависимостей. Запуск: node server.js
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- конфиг ----------
const CONFIG_FILE = path.join(__dirname, 'config.json');
let TOKEN, STARS_PRICE = 100, PORT = 8787, MINIAPP_URL = '';
if (fs.existsSync(CONFIG_FILE)) {
  const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  TOKEN = c.TOKEN; STARS_PRICE = c.STARS_PRICE || STARS_PRICE; PORT = c.PORT || PORT;
  MINIAPP_URL = c.MINIAPP_URL || '';
}
if (!TOKEN && process.env.BOT_TOKEN) TOKEN = process.env.BOT_TOKEN;
if (!MINIAPP_URL && process.env.MINIAPP_URL) MINIAPP_URL = process.env.MINIAPP_URL;
if (!TOKEN) { console.error('Нет токена: создай server/config.json {"TOKEN":"..."}'); process.exit(1); }

const USERS_FILE = path.join(__dirname, 'users.json'); // gitignore!
const loadUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } };
// атомарная запись: сперва во временный файл, потом rename — users.json не побьётся при сбое
const saveUsers = (u) => {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(u, null, 2));
  fs.renameSync(tmp, USERS_FILE);
};
const PRO_DAYS = 30;
const TRIAL_DAYS = 3;

// ---------- Telegram API ----------
const api = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) console.warn('TG API error:', method, j.description);
  return j;
};

const sendInvoice = (chatId) => api('sendInvoice', {
  chat_id: chatId,
  title: 'PRO-подписка PXAXBET2016 AI',
  description: `Доступ к VIP-прогнозам Pro-ИИ на ${PRO_DAYS} дней`,
  payload: `pro_${PRO_DAYS}d`,
  currency: 'XTR', // Telegram Stars
  prices: [{ label: `PRO на ${PRO_DAYS} дней`, amount: STARS_PRICE }],
});

// ---------- валидация initData (официальный алгоритм Telegram) ----------
function validateInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheck = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const computed = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
    if (computed !== hash) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch { return null; }
}

// ---------- статус/выдача PRO ----------
function isPro(uid) {
  const u = loadUsers()[String(uid)];
  return !!(u && new Date(u.until) > new Date());
}
// считаем новую дату окончания поверх действующей подписки
function extendUntil(u, days = PRO_DAYS) {
  const base = u.until && new Date(u.until) > new Date() ? new Date(u.until) : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString();
}
function grant(uid, name, days = PRO_DAYS, extra = {}) {
  const users = loadUsers();
  const prev = users[String(uid)] || {};
  const until = extendUntil(prev, days);
  // сохраняем все прежние поля (payments, trial и т.д.) — одна запись за вызов
  users[String(uid)] = { ...prev, ...extra, until, name: name || prev.name || '' };
  saveUsers(users);
  return until;
}

// ---------- HTTP API ----------
const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/status') {
      const uid = url.searchParams.get('uid');
      const u = loadUsers()[String(uid)];
      // историю платежей отдаём только владельцу (валидная подпись Telegram),
      // иначе статус любого uid можно было перебрать
      const auth = validateInitData(url.searchParams.get('initData') || '');
      const own = !!(auth && String(auth.id) === String(uid));
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({
        pro: isPro(uid),
        until: u?.until || null,
        price: STARS_PRICE,
        days: PRO_DAYS,
        trialUsed: !!u?.trial,
        payments: own ? (u?.payments || []) : [],
      }));
    }
    if (url.pathname === '/trial' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { initData } = JSON.parse(body || '{}');
      const user = validateInitData(initData || '');
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...cors });
        return res.end(JSON.stringify({ ok: false, error: 'bad_auth' }));
      }
      if (isPro(user.id)) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        return res.end(JSON.stringify({ ok: false, reason: 'active' }));
      }
      const users = loadUsers();
      const u = users[String(user.id)] || {};
      if (u.trial) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        return res.end(JSON.stringify({ ok: false, reason: 'used' }));
      }
      const until = grant(user.id, user.first_name, TRIAL_DAYS, { trial: true });
      console.log(`TRIAL: ${user.username || user.id} -> until ${until}`);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({ ok: true, until }));
    }
    if (url.pathname === '/pay' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { initData } = JSON.parse(body || '{}');
      const user = validateInitData(initData || '');
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...cors });
        return res.end(JSON.stringify({ ok: false, error: 'bad_auth' }));
      }
      const inv = await sendInvoice(user.id);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({
        ok: true,
        sent: !!inv.ok,
        needs_start: inv.description?.includes('initiated') || false,
      }));
    }
    res.writeHead(404, cors); res.end();
  } catch (e) {
    console.error('API error:', e);
    res.writeHead(500, cors); res.end(JSON.stringify({ error: 'internal' }));
  }
});
server.listen(PORT, () => console.log(`API on :${PORT}`));

// ---------- long polling ----------
let offset = 0;
async function poll() {
  try {
    const j = await api('getUpdates', { timeout: 25, offset });
    for (const upd of j.result || []) {
      offset = upd.update_id + 1;
      const msg = upd.message;
      if (upd.pre_checkout_query) {
        // принимаем только свой payload — инвойсы с чужим/поддельным payload отклоняем
        const okPay = upd.pre_checkout_query.payload === `pro_${PRO_DAYS}d`;
        await api('answerPreCheckoutQuery', {
          pre_checkout_query_id: upd.pre_checkout_query.id,
          ok: okPay,
          error_message: okPay ? undefined : 'Счёт устарел — оформите подписку заново',
        });
        continue;
      }
      if (!msg) continue;
      const chatId = msg.chat.id;
      if (msg.successful_payment) {
        const pay = msg.successful_payment;
        const users = loadUsers();
        const u = users[String(chatId)] || {};
        u.charges = u.charges || [];
        // идемпотентность: после перезапуска бот может получить апдейт повторно —
        // один charge_id = одно продление
        if (u.charges.includes(pay.telegram_payment_charge_id)) continue;
        u.charges.push(pay.telegram_payment_charge_id);
        if (u.charges.length > 50) u.charges = u.charges.slice(-50);
        const until = extendUntil(u);
        u.until = until;
        u.name = msg.from.first_name || u.name || '';
        u.payments = u.payments || [];
        u.payments.push({ d: new Date().toISOString(), stars: pay.total_amount });
        if (u.payments.length > 30) u.payments = u.payments.slice(-30);
        users[String(chatId)] = u;
        saveUsers(users);
        console.log(`PAYMENT: ${msg.from.username || chatId} -> PRO until ${until}`);
        await api('sendMessage', { chat_id: chatId, text: `💎 PRO активирована до ${new Date(until).toLocaleDateString('ru-RU')}!\nОткрой мини-апп заново — статус обновится.\n\n_Напоминаем: прогнозы не гарантируют результат, 18+_`, parse_mode: 'Markdown' });
        continue;
      }
      const text = msg.text || '';
      if (text.startsWith('/start') || text.startsWith('/subscribe')) {
        const inv = await sendInvoice(chatId);
        if (!inv.ok) {
          await api('sendMessage', { chat_id: chatId, text: '⚠️ Не удалось выставить счёт. Попробуй позже.' });
        }
      }
    }
  } catch (e) { console.warn('poll:', String(e).slice(0, 120)); }
  setTimeout(poll, 500);
}
poll();
console.log(`Bot polling started. Stars price: ${STARS_PRICE}`);

// ---------- автосайтап: кнопка меню с мини-аппом + команды ----------
// кнопка ставится только если задан MINIAPP_URL (config.json или env) —
// чтобы случайно не перебить кнопку, настроенную вручную через BotFather
(async () => {
  if (MINIAPP_URL) {
    const r = await api('setChatMenuButton', {
      menu_button: { type: 'web_app', text: '🎮 Открыть AI', web_app: { url: MINIAPP_URL } },
    });
    console.log(r.ok ? `Menu button -> ${MINIAPP_URL}` : 'Menu button setup failed: ' + r.description);
  } else {
    console.log('Подсказка: добавь в server/config.json "MINIAPP_URL": "https://..." — у бота появится кнопка мини-аппа в углу чата');
  }
  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'Запустить бота' },
      { command: 'subscribe', description: 'Оформить PRO-подписку' },
    ],
  });
})();
