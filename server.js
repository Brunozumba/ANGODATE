'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');

// Planos: pagamentos geram benefícios
const PLANS = {
  gratis: { name: 'Grátis', price: 0, days: 0, likesPerDay: 10, seeLikes: false, msgBeforeMatch: false, boosts: 0, verified: false, translator: false },
  premium: { name: 'Premium', price: 15000, days: 30, likesPerDay: 100, seeLikes: true, msgBeforeMatch: false, boosts: 1, verified: false, translator: true },
  vip: { name: 'VIP', price: 40000, days: 30, likesPerDay: Infinity, seeLikes: true, msgBeforeMatch: true, boosts: 5, verified: true, translator: true }
};
const METHODS = ['multicaixa_express', 'referencia_multicaixa', 'unitel_money', 'transferencia', 'cartao'];
const CURRENCY = 'AOA';

let db = { users: {}, sessions: {}, likes: [], messages: [], payments: [] };
if (fs.existsSync(DB_FILE)) try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
const id = () => crypto.randomBytes(8).toString('hex');
const today = () => new Date().toISOString().slice(0, 10);

function hash(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }
function planOf(u) {
  if (u.plan !== 'gratis' && new Date(u.planUntil) < new Date()) { u.plan = 'gratis'; u.planUntil = null; u.verified = false; }
  return PLANS[u.plan];
}
function pub(u, viewer) {
  return { id: u.id, name: u.name, age: u.age, gender: u.gender, country: u.country, city: u.city, bio: u.bio,
    languages: u.languages, interests: u.interests, verified: !!u.verified,
    boosted: new Date(u.boostUntil || 0) > new Date() };
}
function me(u) {
  const p = planOf(u);
  if (u.likesDay !== today()) { u.likesDay = today(); u.likesToday = 0; }
  return { ...pub(u), email: u.email, plan: u.plan, planName: p.name, planUntil: u.planUntil, boostsLeft: u.boosts || 0,
    likesLeft: p.likesPerDay === Infinity ? null : Math.max(0, p.likesPerDay - u.likesToday),
    benefits: { seeLikes: p.seeLikes, msgBeforeMatch: p.msgBeforeMatch, translator: p.translator, verified: u.verified } };
}
const isMatch = (a, b) => db.likes.some(l => l.from === a && l.to === b) && db.likes.some(l => l.from === b && l.to === a);

const routes = [];
const route = (m, p, auth, fn) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, fn });
const fail = (code, msg) => { const e = new Error(msg); e.code = code; throw e; };

route('GET', '/api/plans', false, () => ({ currency: CURRENCY, methods: METHODS,
  plans: Object.entries(PLANS).map(([k, p]) => ({ id: k, ...p, likesPerDay: p.likesPerDay === Infinity ? null : p.likesPerDay })) }));

route('POST', '/api/register', false, ({ body }) => {
  const { email, password, name, age, gender, country, city, bio, languages, interests } = body;
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) fail(400, 'Email inválido');
  if (!password || password.length < 6) fail(400, 'Senha deve ter 6+ caracteres');
  if (!name) fail(400, 'Nome obrigatório');
  if (!Number.isInteger(age) || age < 18) fail(400, 'Apenas maiores de 18 anos');
  if (Object.values(db.users).some(u => u.email === email.toLowerCase())) fail(409, 'Email já registado');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: id(), email: email.toLowerCase(), salt, pw: hash(password, salt), name: String(name).slice(0, 60), age,
    gender: gender || '', country: country || '', city: city || 'Luanda', bio: String(bio || '').slice(0, 500),
    languages: languages || [], interests: interests || [], plan: 'gratis', planUntil: null, boosts: 0, likesDay: today(), likesToday: 0, verified: false };
  db.users[u.id] = u;
  const token = id() + id(); db.sessions[token] = u.id; save();
  return { token, user: me(u) };
});

route('POST', '/api/login', false, ({ body }) => {
  const u = Object.values(db.users).find(x => x.email === String(body.email || '').toLowerCase());
  if (!u || hash(String(body.password || ''), u.salt) !== u.pw) fail(401, 'Credenciais inválidas');
  const token = id() + id(); db.sessions[token] = u.id; save();
  return { token, user: me(u) };
});

route('GET', '/api/me', true, ({ user }) => { const r = me(user); save(); return r; });

route('PUT', '/api/me', true, ({ user, body }) => {
  for (const k of ['name', 'gender', 'country', 'city', 'bio']) if (typeof body[k] === 'string') user[k] = body[k].slice(0, k === 'bio' ? 500 : 60);
  for (const k of ['languages', 'interests']) if (Array.isArray(body[k])) user[k] = body[k].slice(0, 20).map(String);
  save(); return me(user);
});

// Descobrir: impulsionados e VIP primeiro
route('GET', '/api/discover', true, ({ user }) => {
  const seen = new Set(db.likes.filter(l => l.from === user.id).map(l => l.to));
  const list = Object.values(db.users).filter(u => u.id !== user.id && !seen.has(u.id));
  list.forEach(planOf);
  const score = u => (new Date(u.boostUntil || 0) > new Date() ? 2 : 0) + (u.plan === 'vip' ? 1 : u.plan === 'premium' ? 0.5 : 0);
  return list.sort((a, b) => score(b) - score(a)).map(u => pub(u));
});

route('POST', '/api/like/:to', true, ({ user, params, body }) => {
  const target = db.users[params.to];
  if (!target || target.id === user.id) fail(404, 'Utilizador não encontrado');
  const p = planOf(user); me(user);
  if (db.likes.some(l => l.from === user.id && l.to === target.id)) fail(409, 'Já enviou like');
  if (user.likesToday >= p.likesPerDay) fail(402, 'Limite diário de likes atingido. Faça upgrade do plano.');
  user.likesToday++;
  db.likes.push({ from: user.id, to: target.id, at: Date.now(), superLike: !!body.superLike });
  const match = isMatch(user.id, target.id); save();
  return { liked: true, match };
});

route('GET', '/api/likes-received', true, ({ user }) => {
  const p = planOf(user);
  const got = db.likes.filter(l => l.to === user.id && !db.likes.some(x => x.from === user.id && x.to === l.from));
  if (!p.seeLikes) return { locked: true, count: got.length, users: [] };
  return { locked: false, count: got.length, users: got.map(l => pub(db.users[l.from])) };
});

route('GET', '/api/matches', true, ({ user }) =>
  db.likes.filter(l => l.from === user.id && isMatch(user.id, l.to)).map(l => pub(db.users[l.to])));

route('GET', '/api/messages/:with', true, ({ user, params }) =>
  db.messages.filter(m => (m.from === user.id && m.to === params.with) || (m.from === params.with && m.to === user.id)));

route('POST', '/api/messages/:to', true, ({ user, params, body }) => {
  if (!db.users[params.to]) fail(404, 'Utilizador não encontrado');
  const text = String(body.text || '').trim().slice(0, 1000);
  if (!text) fail(400, 'Mensagem vazia');
  if (!isMatch(user.id, params.to) && !planOf(user).msgBeforeMatch) fail(402, 'Só pode enviar mensagem a matches. Plano VIP permite mensagens diretas.');
  const m = { id: id(), from: user.id, to: params.to, text, at: Date.now() };
  db.messages.push(m); save(); return m;
});

// Pagamento: cria e confirma (gateway simulado; integrar Multicaixa/EMIS em produção) -> concede benefícios
route('POST', '/api/pay', true, ({ user, body }) => {
  const { item, method } = body;
  if (!METHODS.includes(method)) fail(400, 'Método de pagamento inválido');
  let amount, desc;
  if (PLANS[item] && item !== 'gratis') { amount = PLANS[item].price; desc = 'Plano ' + PLANS[item].name; }
  else if (item === 'boost') { amount = 3000; desc = 'Impulso de perfil (24h)'; }
  else fail(400, 'Item inválido');
  const pay = { id: id(), userId: user.id, item, method, amount, currency: CURRENCY, desc, at: Date.now(), status: 'pago',
    reference: method === 'referencia_multicaixa' ? String(Math.floor(100000000 + Math.random() * 899999999)) : undefined };
  if (PLANS[item]) {
    const p = PLANS[item];
    const start = user.plan === item && new Date(user.planUntil) > new Date() ? new Date(user.planUntil) : new Date();
    user.plan = item; user.planUntil = new Date(start.getTime() + p.days * 864e5).toISOString();
    user.boosts = (user.boosts || 0) + p.boosts; if (p.verified) user.verified = true;
  } else user.boostUntil = new Date(Math.max(Date.now(), new Date(user.boostUntil || 0).getTime()) + 864e5).toISOString();
  db.payments.push(pay); save();
  return { payment: pay, user: me(user) };
});

route('POST', '/api/boost', true, ({ user }) => {
  if (!(user.boosts > 0)) fail(402, 'Sem impulsos. Compre um ou faça upgrade.');
  user.boosts--; user.boostUntil = new Date(Math.max(Date.now(), new Date(user.boostUntil || 0).getTime()) + 864e5).toISOString();
  save(); return me(user);
});

route('GET', '/api/payments', true, ({ user }) => db.payments.filter(p => p.userId === user.id));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (!url.pathname.startsWith('/api/')) {
    const f = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res);
  }
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try {
      const r = routes.find(r => r.m === req.method && r.re.test(url.pathname));
      if (!r) return send(404, { error: 'Rota não encontrada' });
      let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (e) { fail(400, 'JSON inválido'); }
      let user = null;
      if (r.auth) {
        const t = (req.headers.authorization || '').replace('Bearer ', '');
        user = db.users[db.sessions[t]]; if (!user) fail(401, 'Não autenticado');
      }
      send(200, r.fn({ user, body, params: url.pathname.match(r.re).groups || {} }));
    } catch (e) { send(e.code || 500, { error: e.message }); }
  });
});
if (require.main === module) server.listen(process.env.PORT || 3000, () => console.log('AngoDate em http://localhost:' + (process.env.PORT || 3000)));
module.exports = server;
