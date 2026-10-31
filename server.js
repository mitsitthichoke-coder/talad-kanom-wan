'use strict';
/* Sweet Market server: accounts, cloud save, leaderboard, friends.
   - Production (Render): set DATABASE_URL -> Postgres.
   - Local dev: no DATABASE_URL -> JSON file (DATA_FILE, default ./data.json). Not for Render: its disk is wiped on restart. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const NAME_RE = /^[\p{L}\p{M}\p{N}_.-]{3,20}$/u;
const NICK_RE = /^[\p{L}\p{M}\p{N}_. -]{2,16}$/u;
const MAX_LEVEL = 2000, MAX_BODY = 256 * 1024, MAX_FRIENDS = 100;
const ONLINE_MS = 2 * 60 * 1000, DAY = 24 * 60 * 60 * 1000;
const GIFT_COINS = [10, 25, 50], GIFT_ITEMS = ['hammer', 'mortar', 'fan', 'lantern', 'shuffle', 'moves'];
const GIFT_PER_FRIEND = 5, GIFT_PER_DAY = 20;
const cmp = (a, b) => b.level - a.level || b.stars - a.stars || a.updated - b.updated || a.id - b.id;

/* ---------------- storage ---------------- */
function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 5,
    ssl: /\.render\.com|\.neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined });
  // Neon (and Render) may close idle connections; without this handler an idle-client error would crash the server.
  pool.on('error', e => console.warn('[pg] idle client error:', e.message));
  const q = (t, p) => pool.query(t, p).then(r => r.rows);
  const row = r => r && { id: +r.id, name: r.name, nick: r.nick || null, key: r.key, salt: r.salt, hash: r.hash,
    level: r.level, stars: r.stars, updated: +r.updated_at, save: r.save, seen: +r.seen || 0 };
  return {
    async init() {
      await q(`create table if not exists users(
        id serial primary key, name text not null, key text not null unique, salt text not null, hash text not null,
        level int not null default 1, stars int not null default 0, save jsonb,
        updated_at bigint not null, created_at bigint not null)`);
      await q(`create table if not exists sessions(
        token_hash text primary key, user_id int not null references users(id) on delete cascade, created_at bigint not null)`);
      await q(`create table if not exists friends(
        user_id int not null references users(id) on delete cascade,
        friend_id int not null references users(id) on delete cascade, primary key(user_id, friend_id))`);
      await q('create index if not exists users_rank on users(level desc, stars desc, updated_at asc)');
      await q('alter table users add column if not exists nick text');
      await q('alter table users add column if not exists nick_key text');
      await q('create unique index if not exists users_nick_key on users(nick_key) where nick_key is not null');
      await q('alter table users add column if not exists seen bigint not null default 0');
      await q(`create table if not exists friend_requests(
        from_id int not null references users(id) on delete cascade,
        to_id int not null references users(id) on delete cascade, created_at bigint not null, primary key(from_id, to_id))`);
      await q(`create table if not exists mail(
        id serial primary key, to_id int not null references users(id) on delete cascade,
        from_id int references users(id) on delete set null, kind text not null, body jsonb not null default '{}'::jsonb,
        created_at bigint not null, read boolean not null default false, claimed boolean not null default false)`);
      await q('create index if not exists mail_to on mail(to_id, id desc)');
    },
    async createUser(u) {
      const r = await q(`insert into users(name,key,salt,hash,level,stars,updated_at,created_at)
        values($1,$2,$3,$4,1,0,$5,$5) on conflict (key) do nothing returning id`, [u.name, u.key, u.salt, u.hash, u.now]);
      return r[0] ? +r[0].id : null;
    },
    async userByKey(k) { return row((await q('select * from users where key=$1', [k]))[0]); },
    async userByNick(k) { return row((await q('select * from users where nick_key=$1', [k]))[0]); },
    async setNick(id, nick, key) {
      try { return !!(await q('update users set nick=$2, nick_key=$3 where id=$1 returning id', [id, nick, key]))[0]; }
      catch (e) { if (e && e.code === '23505') return false; throw e; }
    },
    async addSession(h, id) { await q('insert into sessions(token_hash,user_id,created_at) values($1,$2,$3)', [h, id, Date.now()]); },
    async userBySession(h) {
      return row((await q('select u.* from sessions s join users u on u.id=s.user_id where s.token_hash=$1', [h]))[0]);
    },
    async delSession(h) { await q('delete from sessions where token_hash=$1', [h]); },
    async setSave(id, save, level, stars, updated) {
      await q('update users set save=$2::jsonb, level=$3, stars=$4, updated_at=$5 where id=$1', [id, JSON.stringify(save), level, stars, updated]);
    },
    async top(n) {
      return (await q('select id,name,nick,level,stars,updated_at,seen from users order by level desc, stars desc, updated_at asc, id asc limit $1', [n])).map(row);
    },
    async rank(u) {
      const r = await q(`select count(*)+1 as rank from users where level>$1 or (level=$1 and stars>$2)
        or (level=$1 and stars=$2 and (updated_at<$3 or (updated_at=$3 and id<$4)))`, [u.level, u.stars, u.updated, u.id]);
      return +r[0].rank;
    },
    async friends(id) {
      return (await q(`select u.id,u.name,u.nick,u.level,u.stars,u.updated_at,u.seen from friends f join users u on u.id=f.friend_id where f.user_id=$1`, [id])).map(row);
    },
    async addFriend(id, fid) { await q('insert into friends(user_id,friend_id) values($1,$2) on conflict do nothing', [id, fid]); },
    async delFriend(id, fid) { await q('delete from friends where user_id=$1 and friend_id=$2', [id, fid]); },
    async hasFriend(id, fid) { return (await q('select 1 from friends where user_id=$1 and friend_id=$2', [id, fid])).length > 0; },
    async touch(id, now) { await q('update users set seen=$2 where id=$1', [id, now]); },
    async addRequest(from, to) { await q('insert into friend_requests(from_id,to_id,created_at) values($1,$2,$3) on conflict do nothing', [from, to, Date.now()]); },
    async delRequest(from, to) { return (await q('delete from friend_requests where from_id=$1 and to_id=$2 returning from_id', [from, to])).length > 0; },
    async hasRequest(from, to) { return (await q('select 1 from friend_requests where from_id=$1 and to_id=$2', [from, to])).length > 0; },
    async requestsTo(id) {
      return (await q(`select u.id,u.name,u.nick,u.level,u.stars,u.updated_at,u.seen,r.created_at as at from friend_requests r
        join users u on u.id=r.from_id where r.to_id=$1 order by r.created_at desc limit 50`, [id])).map(x => Object.assign(row(x), { at: +x.at }));
    },
    async requestsFrom(id) {
      return (await q(`select u.id,u.name,u.nick,u.level,u.stars,u.updated_at,u.seen from friend_requests r
        join users u on u.id=r.to_id where r.from_id=$1`, [id])).map(row);
    },
    async addMail(to, from, kind, body) {
      await q('insert into mail(to_id,from_id,kind,body,created_at) values($1,$2,$3,$4::jsonb,$5)', [to, from, kind, JSON.stringify(body), Date.now()]);
      await q('delete from mail where to_id=$1 and id not in (select id from mail where to_id=$1 order by id desc limit 100)', [to]);
    },
    async mailFor(id) {
      return (await q(`select m.id,m.kind,m.body,m.created_at,m.read,m.claimed,u.name as from_name,u.nick as from_nick
        from mail m left join users u on u.id=m.from_id where m.to_id=$1 order by m.id desc limit 100`, [id]))
        .map(x => ({ id: +x.id, kind: x.kind, body: x.body, at: +x.created_at, read: x.read, claimed: x.claimed, fromName: x.from_nick || x.from_name || null }));
    },
    async claimMail(id, uid) {
      const r = await q("update mail set claimed=true, read=true where id=$1 and to_id=$2 and claimed=false and kind='gift' returning body", [id, uid]);
      return r[0] ? r[0].body : null;
    },
    async readMail(id, uid) { await q('update mail set read=true where id=$1 and to_id=$2', [id, uid]); },
    async delMail(id, uid) { await q("delete from mail where id=$1 and to_id=$2 and (claimed=true or kind<>'gift')", [id, uid]); },
    async mailUnread(id) {
      return +(await q("select count(*) c from mail where to_id=$1 and (read=false or (kind='gift' and claimed=false))", [id]))[0].c;
    },
    async giftsSince(from, to, since) {
      return +(await q("select count(*) c from mail where from_id=$1 and ($2::int is null or to_id=$2) and kind='gift' and created_at>$3", [from, to, since]))[0].c;
    },
  };
}

function fileStore(file) {
  let d = { seq: 0, users: [], sessions: {}, friends: [] }, t = null;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  d.requests = d.requests || []; d.mail = d.mail || []; d.mailSeq = d.mailSeq || 0;
  const flush = () => { clearTimeout(t); t = setTimeout(() => { try { fs.writeFileSync(file, JSON.stringify(d)); } catch (e) { console.error(e); } }, 300); };
  const byId = id => d.users.find(u => u.id === id) || null;
  return {
    async init() {},
    async createUser(u) {
      if (d.users.some(x => x.key === u.key)) return null;
      const r = { id: ++d.seq, name: u.name, nick: null, nickKey: null, key: u.key, salt: u.salt, hash: u.hash, level: 1, stars: 0, updated: u.now, save: null, seen: 0 };
      d.users.push(r); flush(); return r.id;
    },
    async userByKey(k) { return d.users.find(u => u.key === k) || null; },
    async userByNick(k) { return d.users.find(u => u.nickKey === k) || null; },
    async setNick(id, nick, key) {
      if (d.users.some(u => u.id !== id && u.nickKey === key)) return false;
      Object.assign(byId(id), { nick, nickKey: key }); flush(); return true;
    },
    async addSession(h, id) { d.sessions[h] = id; flush(); },
    async userBySession(h) { return byId(d.sessions[h]); },
    async delSession(h) { delete d.sessions[h]; flush(); },
    async setSave(id, save, level, stars, updated) { Object.assign(byId(id), { save, level, stars, updated }); flush(); },
    async top(n) { return [...d.users].sort(cmp).slice(0, n); },
    async rank(u) { return d.users.filter(x => cmp(x, u) < 0).length + 1; },
    async friends(id) { return d.friends.filter(f => f[0] === id).map(f => byId(f[1])).filter(Boolean); },
    async addFriend(id, fid) { if (!d.friends.some(f => f[0] === id && f[1] === fid)) { d.friends.push([id, fid]); flush(); } },
    async delFriend(id, fid) { d.friends = d.friends.filter(f => !(f[0] === id && f[1] === fid)); flush(); },
    async hasFriend(id, fid) { return d.friends.some(f => f[0] === id && f[1] === fid); },
    async touch(id, now) { const u = byId(id); if (u) { u.seen = now; flush(); } },
    async addRequest(from, to) { if (!d.requests.some(r => r[0] === from && r[1] === to)) { d.requests.push([from, to, Date.now()]); flush(); } },
    async delRequest(from, to) { const n = d.requests.length; d.requests = d.requests.filter(r => !(r[0] === from && r[1] === to)); flush(); return d.requests.length < n; },
    async hasRequest(from, to) { return d.requests.some(r => r[0] === from && r[1] === to); },
    async requestsTo(id) { return d.requests.filter(r => r[1] === id).sort((a, b) => b[2] - a[2]).slice(0, 50).map(r => Object.assign({}, byId(r[0]), { at: r[2] })).filter(x => x.id); },
    async requestsFrom(id) { return d.requests.filter(r => r[0] === id).map(r => byId(r[1])).filter(Boolean); },
    async addMail(to, from, kind, body) {
      d.mail.push({ id: ++d.mailSeq, to, from, kind, body, at: Date.now(), read: false, claimed: false });
      const mine = d.mail.filter(m => m.to === to).sort((a, b) => b.id - a.id);
      if (mine.length > 100) { const drop = new Set(mine.slice(100).map(m => m.id)); d.mail = d.mail.filter(m => !drop.has(m.id)); }
      flush();
    },
    async mailFor(id) {
      return d.mail.filter(m => m.to === id).sort((a, b) => b.id - a.id).slice(0, 100).map(m => {
        const f = m.from ? byId(m.from) : null;
        return { id: m.id, kind: m.kind, body: m.body, at: m.at, read: m.read, claimed: m.claimed, fromName: f ? (f.nick || f.name) : null };
      });
    },
    async claimMail(id, uid) {
      const m = d.mail.find(x => x.id === id && x.to === uid && !x.claimed && x.kind === 'gift');
      if (!m) return null; m.claimed = true; m.read = true; flush(); return m.body;
    },
    async readMail(id, uid) { const m = d.mail.find(x => x.id === id && x.to === uid); if (m) { m.read = true; flush(); } },
    async delMail(id, uid) { d.mail = d.mail.filter(m => !(m.id === id && m.to === uid && (m.claimed || m.kind !== 'gift'))); flush(); },
    async mailUnread(id) { return d.mail.filter(m => m.to === id && (!m.read || (m.kind === 'gift' && !m.claimed))).length; },
    async giftsSince(from, to, since) { return d.mail.filter(m => m.from === from && (to == null || m.to === to) && m.kind === 'gift' && m.at > since).length; },
  };
}

const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL)
  : fileStore(process.env.DATA_FILE || path.join(__dirname, 'data.json'));
if (!process.env.DATABASE_URL) console.warn('[warn] DATABASE_URL not set: using a local JSON file (data is lost on Render restarts).');

/* ---------------- helpers ---------------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const send = (res, code, obj, extra) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra));
  res.end(body);
};
const fail = (res, code, msg) => send(res, code, { error: msg });
function readBody(req) {
  return new Promise((ok, no) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(Object.assign(new Error('big'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return ok({}); try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { no(Object.assign(new Error('json'), { code: 400 })); } });
    req.on('error', no);
  });
}
const hits = new Map();
function limited(ip, max = 30, ms = 10 * 60 * 1000) {
  const now = Date.now(); let h = hits.get(ip);
  if (!h || h.reset < now) { h = { n: 0, reset: now + ms }; hits.set(ip, h); }
  return ++h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60000).unref();
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const tokenOf = req => { const m = /^Bearer\s+([a-f0-9]{64})$/.exec(req.headers.authorization || ''); return m ? m[1] : null; };

async function startSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await store.addSession(sha(token), userId);
  return token;
}
const DUMMY_SALT = 'x'.repeat(32);

/* ---------------- routes ---------------- */
const routes = [];
const route = (m, re, fn, authed) => routes.push([m, re, fn, !!authed]);

route('POST', /^\/api\/register$/, async (req, res, c) => {
  if (limited(c.ip)) return fail(res, 429, 'ลองบ่อยเกินไป รอสักครู่แล้วลองใหม่');
  const name = String(c.body.username || '').trim(), pw = String(c.body.password || '');
  if (!NAME_RE.test(name)) return fail(res, 400, 'ชื่อผู้ใช้ต้องยาว 3–20 ตัว ใช้ตัวอักษร ตัวเลข _ . - ได้เท่านั้น');
  if (pw.length < 6 || pw.length > 64) return fail(res, 400, 'รหัสผ่านต้องยาว 6–64 ตัวอักษร');
  const salt = crypto.randomBytes(16).toString('hex');
  const id = await store.createUser({ name, key: name.toLowerCase(), salt, hash: await hashPw(pw, salt), now: Date.now() });
  if (!id) return fail(res, 409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว ลองชื่ออื่นหรือเข้าสู่ระบบ');
  send(res, 200, { token: await startSession(id), name, nick: null, save: null });
});

route('POST', /^\/api\/login$/, async (req, res, c) => {
  if (limited(c.ip)) return fail(res, 429, 'ลองบ่อยเกินไป รอสักครู่แล้วลองใหม่');
  const name = String(c.body.username || '').trim(), pw = String(c.body.password || '');
  const u = pw.length <= 64 && name.length <= 20 ? await store.userByKey(name.toLowerCase()) : null;
  const h = await hashPw(pw.slice(0, 64), u ? u.salt : DUMMY_SALT); // same cost whether or not the user exists
  if (!u || !safeEq(h, u.hash)) return fail(res, 401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  send(res, 200, { token: await startSession(u.id), name: u.name, nick: u.nick || null, save: u.save || null });
});

route('POST', /^\/api\/logout$/, async (req, res, c) => {
  const t = tokenOf(req); if (t) await store.delSession(sha(t));
  send(res, 200, { ok: true });
});

route('GET', /^\/api\/me$/, async (req, res, c, u) => send(res, 200, { name: u.name, nick: u.nick || null, save: u.save || null }), true);

route('PUT', /^\/api\/nick$/, async (req, res, c, u) => {
  if (limited(c.ip, 40)) return fail(res, 429, 'ลองบ่อยเกินไป รอสักครู่แล้วลองใหม่');
  const nick = String(c.body.nick || '').trim().replace(/\s+/g, ' ');
  if (!NICK_RE.test(nick)) return fail(res, 400, 'ชื่อต้องยาว 2–16 ตัว ใช้ตัวอักษร ตัวเลข ช่องว่าง _ . - ได้เท่านั้น');
  const key = nick.toLowerCase();
  const clash = await store.userByKey(key);                 // do not impersonate someone's login name
  if (clash && clash.id !== u.id) return fail(res, 409, 'ชื่อนี้มีคนใช้แล้ว ลองชื่ออื่น');
  if (!(await store.setNick(u.id, nick, key))) return fail(res, 409, 'ชื่อนี้มีคนใช้แล้ว ลองชื่ออื่น');
  send(res, 200, { ok: true, nick });
}, true);

route('PUT', /^\/api\/save$/, async (req, res, c, u) => {
  const s = c.body && c.body.save;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return fail(res, 400, 'ข้อมูลไม่ถูกต้อง');
  const level = Math.floor(+s.unlocked);
  if (!(level >= 1 && level <= MAX_LEVEL)) return fail(res, 400, 'ข้อมูลไม่ถูกต้อง');
  let stars = 0;
  if (s.stars && typeof s.stars === 'object') for (const k in s.stars) {
    const v = Math.floor(+s.stars[k]), lv = +k;
    if (v >= 1 && v <= 3 && lv >= 1 && lv <= MAX_LEVEL) stars += v;
  }
  if (level < u.level) return send(res, 200, { ok: true, stale: true }); // progress never goes backwards
  const now = Date.now();
  const allowed = 3 + Math.floor((now - u.updated) / 10000); // a few levels, plus ~1 per 10s since last progress
  if (level - u.level > allowed || stars > 3 * level) return fail(res, 409, 'ข้อมูลความคืบหน้าผิดปกติ');
  const changed = level !== u.level || stars !== u.stars;
  await store.setSave(u.id, s, level, stars, changed ? now : u.updated);
  send(res, 200, { ok: true });
}, true);

const isOnline = r => Date.now() - (r.seen || 0) < ONLINE_MS;
const disp = r => r.nick || r.name;

route('GET', /^\/api\/leaderboard$/, async (req, res, c, u) => {
  const [top, friends, rank, sent] = await Promise.all([store.top(50), store.friends(u.id), store.rank(u), store.requestsFrom(u.id)]);
  const fset = new Set(friends.map(f => f.id));
  const pub = (r, rk) => ({ rank: rk, name: disp(r), user: r.name, level: r.level, stars: r.stars, me: r.id === u.id, friend: fset.has(r.id), online: r.id === u.id || isOnline(r) });
  friends.sort(cmp);
  send(res, 200, {
    top: top.map((r, i) => pub(r, i + 1)),
    me: { rank, name: disp(u), user: u.name, level: u.level, stars: u.stars },
    friends: friends.map(f => ({ name: disp(f), user: f.name, level: f.level, stars: f.stars, online: isOnline(f) })),
    friendsBoard: [...friends, u].sort(cmp).map((r, i) => pub(r, i + 1)),
    pending: sent.map(r => ({ name: disp(r), user: r.name })),
  });
}, true);

const findUser = async raw => { const key = String(raw || '').trim().toLowerCase(); return key ? ((await store.userByKey(key)) || (await store.userByNick(key))) : null; };
const areFriends = async (a, b) => (await store.hasFriend(a, b)) && (await store.hasFriend(b, a));

/* friend request (the other side must accept) */
route('POST', /^\/api\/friends$/, async (req, res, c, u) => {
  if (limited(c.ip + ':fr', 60)) return fail(res, 429, 'ลองบ่อยเกินไป รอสักครู่แล้วลองใหม่');
  const f = await findUser(c.body.name);
  if (!f) return fail(res, 404, 'ไม่พบผู้เล่นชื่อนี้');
  if (f.id === u.id) return fail(res, 400, 'เพิ่มตัวเองเป็นเพื่อนไม่ได้');
  if (await areFriends(u.id, f.id)) return send(res, 200, { ok: true, status: 'already' });
  if ((await store.friends(u.id)).length >= MAX_FRIENDS) return fail(res, 400, 'เพิ่มเพื่อนได้สูงสุด ' + MAX_FRIENDS + ' คน');
  if (await store.hasRequest(f.id, u.id)) {                        // they already asked me: becoming friends right away
    await store.delRequest(f.id, u.id); await store.addFriend(u.id, f.id); await store.addFriend(f.id, u.id);
    await store.addMail(f.id, u.id, 'system', { text: disp(u) + ' ตอบรับเป็นเพื่อนของคุณแล้ว' });
    return send(res, 200, { ok: true, status: 'friends', name: disp(f) });
  }
  if (await store.hasRequest(u.id, f.id)) return send(res, 200, { ok: true, status: 'sent', name: disp(f) });
  await store.addRequest(u.id, f.id);
  send(res, 200, { ok: true, status: 'sent', name: disp(f) });
}, true);

route('POST', /^\/api\/friends\/accept$/, async (req, res, c, u) => {
  const f = await findUser(c.body.user);
  if (!f || !(await store.delRequest(f.id, u.id))) return fail(res, 404, 'ไม่พบคำขอเป็นเพื่อนนี้ (อาจถูกยกเลิกแล้ว)');
  if ((await store.friends(u.id)).length >= MAX_FRIENDS) return fail(res, 400, 'เพิ่มเพื่อนได้สูงสุด ' + MAX_FRIENDS + ' คน');
  await store.addFriend(u.id, f.id); await store.addFriend(f.id, u.id);
  await store.addMail(f.id, u.id, 'system', { text: disp(u) + ' ตอบรับเป็นเพื่อนของคุณแล้ว' });
  send(res, 200, { ok: true, name: disp(f) });
}, true);

route('POST', /^\/api\/friends\/decline$/, async (req, res, c, u) => {
  const f = await findUser(c.body.user);
  if (f) await store.delRequest(f.id, u.id);
  send(res, 200, { ok: true });
}, true);

route('DELETE', /^\/api\/friends\/([^/]+)$/, async (req, res, c, u) => {
  let key; try { key = decodeURIComponent(c.m[1]); } catch (e) { return fail(res, 400, 'ชื่อไม่ถูกต้อง'); }
  const f = await findUser(key);
  if (f) { await store.delFriend(u.id, f.id); await store.delFriend(f.id, u.id); await store.delRequest(u.id, f.id); await store.delRequest(f.id, u.id); }
  send(res, 200, { ok: true });
}, true);

/* mailbox: friend requests + letters + gifts */
route('GET', /^\/api\/mailbox$/, async (req, res, c, u) => {
  const [reqs, mail] = await Promise.all([store.requestsTo(u.id), store.mailFor(u.id)]);
  send(res, 200, {
    requests: reqs.map(r => ({ name: disp(r), user: r.name, level: r.level, online: isOnline(r), at: r.at })),
    mail: mail.map(m => ({ id: m.id, kind: m.kind, from: m.fromName, at: m.at, read: m.read, claimed: m.claimed,
      gift: m.kind === 'gift' ? { type: m.body.type, n: m.body.n, item: m.body.item || null } : null, text: String((m.body && (m.body.msg || m.body.text)) || '') })),
  });
}, true);

route('GET', /^\/api\/ping$/, async (req, res, c, u) => {
  const [mail, reqs] = await Promise.all([store.mailUnread(u.id), store.requestsTo(u.id)]);
  send(res, 200, { mail, requests: reqs.length });
}, true);

route('POST', /^\/api\/mail\/send$/, async (req, res, c, u) => {
  if (limited(c.ip + ':gift', 80)) return fail(res, 429, 'ลองบ่อยเกินไป รอสักครู่แล้วลองใหม่');
  const f = await findUser(c.body.user);
  if (!f || f.id === u.id) return fail(res, 404, 'ไม่พบเพื่อนคนนี้');
  if (!(await areFriends(u.id, f.id))) return fail(res, 403, 'ส่งของขวัญให้ได้เฉพาะเพื่อนที่ตอบรับแล้ว');
  const g = c.body.gift || {}, type = String(g.type || ''), n = Math.floor(+g.n || 1);
  let gift = null;
  if (type === 'heart' && n === 1) gift = { type, n: 1 };
  else if (type === 'coin' && GIFT_COINS.includes(n)) gift = { type, n };
  else if (type === 'item' && n === 1 && GIFT_ITEMS.includes(g.item)) gift = { type, n: 1, item: g.item };
  if (!gift) return fail(res, 400, 'ของขวัญไม่ถูกต้อง');
  const msg = String(c.body.msg || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const since = Date.now() - DAY;
  if ((await store.giftsSince(u.id, f.id, since)) >= GIFT_PER_FRIEND) return fail(res, 429, 'วันนี้ส่งให้เพื่อนคนนี้ครบ ' + GIFT_PER_FRIEND + ' ชิ้นแล้ว พรุ่งนี้ส่งใหม่ได้');
  if ((await store.giftsSince(u.id, null, since)) >= GIFT_PER_DAY) return fail(res, 429, 'วันนี้ส่งของขวัญครบ ' + GIFT_PER_DAY + ' ชิ้นแล้ว');
  await store.addMail(f.id, u.id, 'gift', Object.assign(gift, msg ? { msg } : {}));
  send(res, 200, { ok: true, name: disp(f) });
}, true);

route('POST', /^\/api\/mail\/(\d+)\/claim$/, async (req, res, c, u) => {
  const g = await store.claimMail(+c.m[1], u.id);
  if (!g) return fail(res, 404, 'รับของขวัญนี้ไปแล้วหรือไม่พบจดหมาย');
  send(res, 200, { ok: true, gift: { type: g.type, n: g.n, item: g.item || null } });
}, true);

route('POST', /^\/api\/mail\/(\d+)\/read$/, async (req, res, c, u) => { await store.readMail(+c.m[1], u.id); send(res, 200, { ok: true }); }, true);
route('DELETE', /^\/api\/mail\/(\d+)$/, async (req, res, c, u) => { await store.delMail(+c.m[1], u.id); send(res, 200, { ok: true }); }, true);

route('GET', /^\/api\/health$/, async (req, res) => send(res, 200, { ok: true }));

/* ---------------- server ---------------- */
const HTML = () => fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = (req.url || '/').split('?')[0];
  try {
    if (url.startsWith('/api/')) {
      for (const [m, re, fn, authed] of routes) {
        const mm = re.exec(url);
        if (req.method !== m || !mm) continue;
        const c = { ip: clientIp(req), m: mm, body: (m === 'GET' || m === 'DELETE') ? {} : await readBody(req) };
        let u = null;
        if (authed) {
          const t = tokenOf(req); u = t && await store.userBySession(sha(t));
          if (!u) return fail(res, 401, 'กรุณาเข้าสู่ระบบ');
          const now = Date.now();
          if (now - (u.seen || 0) > 20000) { u.seen = now; store.touch(u.id, now).catch(() => {}); }
        }
        return await fn(req, res, c, u);
      }
      return fail(res, 404, 'ไม่พบเส้นทางนี้');
    }
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(HTML());
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
  } catch (e) {
    if (e && e.code === 413) return fail(res, 413, 'ข้อมูลใหญ่เกินไป');
    if (e && e.code === 400) return fail(res, 400, 'ข้อมูลไม่ถูกต้อง');
    console.error(e); if (!res.headersSent) fail(res, 500, 'เซิร์ฟเวอร์ขัดข้อง ลองใหม่อีกครั้ง');
  }
});

// Keep the free Render instance awake: ping our own public URL every 10 minutes.
// RENDER_EXTERNAL_URL is set by Render automatically (set KEEPALIVE_URL yourself to use it elsewhere).
function startKeepAlive() {
  const base = (process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL || '').replace(/\/$/, '');
  if (!base) return;
  setInterval(() => { fetch(base + '/api/health').catch(() => {}); }, 10 * 60 * 1000);
  console.log('Keep-alive ping every 10 min ->', base);
}
store.init().then(() => server.listen(PORT, '0.0.0.0', () => { console.log('Sweet Market on :' + PORT); startKeepAlive(); }))
  .catch(e => { console.error('DB init failed', e); process.exit(1); });
