// PXAX 2016 AI — бэкенд подписки через Telegram Stars
// Node >= 18, без зависимостей. Запуск: node server.js
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- конфиг ----------
const CONFIG_FILE = path.join(__dirname, 'config.json');
let TOKEN, STARS_PRICE = 100, PORT = 8787;
if (fs.existsSync(CONFIG_FILE)) {
  const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  TOKEN = c.TOKEN; STARS_PRICE = c.STARS_PRICE || STARS_PRICE; PORT = c.PORT || PORT;
}
if (!TOKEN && process.env.BOT_TOKEN) TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('Нет токена: создай server/config.json {"TOKEN":"..."}'); process.exit(1); }

const USERS_FILE = path.join(__dirname, 'users.json'); // gitignore!
const loadUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } };
const saveUsers = (u) => fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
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
function grant(uid, name, days = PRO_DAYS) {
  const users = loadUsers();
  const prev = users[String(uid)] || {};
  const base = prev.until && new Date(prev.until) > new Date() ? new Date(prev.until) : new Date();
  base.setDate(base.getDate() + days);
  // сохраняем все прежние поля (payments, trial и т.д.)
  users[String(uid)] = { ...prev, until: base.toISOString(), name: name || prev.name || '' };
  saveUsers(users);
  return users[String(uid)].until;
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
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({
        pro: isPro(uid),
        until: u?.until || null,
        price: STARS_PRICE,
        days: PRO_DAYS,
        trialUsed: !!u?.trial,
        payments: u?.payments || [],
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
      const until = grant(user.id, user.first_name, TRIAL_DAYS);
      const users2 = loadUsers();
      users2[String(user.id)].trial = true;
      saveUsers(users2);
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
    res.writeHead(500, cors); res.end(JSON.stringify({ error: String(e) }));
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
        await api('answerPreCheckoutQuery', { pre_checkout_query_id: upd.pre_checkout_query.id, ok: true });
        continue;
      }
      if (!msg) continue;
      const chatId = msg.chat.id;
      if (msg.successful_payment) {
        const until = grant(chatId, msg.from.first_name);
        // сохраняем историю платежей
        const users = loadUsers();
        const u = users[String(chatId)];
        if (u) {
          u.payments = u.payments || [];
          u.payments.push({ d: new Date().toISOString(), stars: msg.successful_payment.total_amount });
          if (u.payments.length > 30) u.payments = u.payments.slice(-30);
          saveUsers(users);
        }
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
