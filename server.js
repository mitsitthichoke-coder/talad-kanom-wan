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
  
  // ปรับแต่ง Connection URL เพื่อรองรับ libpq compatibility และระบุ sslmode ให้ชัดเจนตามคำแนะนำของระบบ
  let finalUrl = url;
  if (/\.render\.com|\.neon\.tech/.test(url) && !url.includes('uselibpqcompat')) {
    finalUrl += (url.includes('?') ? '&' : '?') + 'uselibpqcompat=true&sslmode=require';
  }

  const pool = new Pool({ 
    connectionString: finalUrl, 
    max: 5,
    ssl: /\.render\.com|\.neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined 
  });
  
  // Neon (and Render) may close idle connections; without this handler an idle-client error would crash the server.
  pool.on('error', e => console.warn('[pg] idle client error:', e.message));
  const q = (t, p) => pool.query(t, p).then(r => r.rows);
  const q1 = (t, p) => q(t, p).then(r => r[0]);   // first row or undefined
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
      const r = await q1(`insert into users(name,key,salt,hash,level,stars,updated_at,created_at)
        values($1,$2,$3,$4,1,0,$5,$5) on conflict (key) do nothing returning id`, [u.name, u.key, u.salt, u.hash, u.now]);
      return r ? +r.id : null;
    },
    async userByKey(k) { return row((await q1('select * from users where key=$1', [k]))); },
    async userByNick(k) { return row((await q1('select * from users where nick_key=$1', [k]))); },
    async setNick(id, nick, key) {
      try { return (await q('update users set nick=$2, nick_key=$3 where id=$1 returning id', [id, nick, key])).length > 0; }
      catch (e) { if (e && e.code === '23505') return false; throw e; }
    },
    async addSession(h, id) { await q('insert into sessions(token_hash,user_id,created_at) values($1,$2,$3)', [h, id, Date.now()]); },
    async userBySession(h) {
      return row((await q1('select u.* from sessions s join users u on u.id=s.user_id where s.token_hash=$1', [h])));
    },
    async delSession(h) { await q('delete from sessions where token_hash=$1', [h]); },
    async setSave(id, save, level, stars, updated) {
      await q('update users set save=$2::jsonb, level=$3, stars=$4, updated_at=$5 where id=$1', [id, JSON.stringify(save), level, stars, updated]);
    },
    async top(n) {
      return (await q('select id,name,nick,level,stars,updated_at,seen from users order by level desc, stars desc, updated_at asc, id asc limit $1', [n])).map(row);
    },
    async rank(u) {
      const r = await q1(`select count(*)+1 as rank from users where level>$1 or (level=$1 and stars>$2)
        or (level=$1 and stars=$2 and (updated_at<$3 or (updated_at=$3 and id<$4)))`, [u.level, u.stars, u.updated, u.id]);
      return +r.rank;
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
      const r = await q1("update mail set claimed=true, read=true where id=$1 and to_id=$2 and claimed=false and kind='gift' returning body", [id, uid]);
      return r ? r.body : null;
    },
    async giftCounts(from, to, since) {
      const r = await q1(`select count(*) filter (where to_id=$2) as pair, count(*) as total from mail
        where from_id=$1 and kind='gift' and created_at>=$3`, [from, to, since]);
      return { pair: +r.pair, total: +r.total };
    },
    async readMail(id, uid) { await q('update mail set read=true where id=$1 and to_id=$2', [id, uid]); },
    async delMail(id, uid) { await q("delete from mail where id=$1 and to_id=$2", [id, uid]); }
  };
}

function fileStore(file) {
  let d = { nextUser: 1, nextMail: 1, users: [], sessions: {}, friends: [], requests: [], mail: [] };
  let timer = null, writing = Promise.resolve();
  const flush = () => {
    writing = writing.then(async () => {
      const tmp = file + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(d));
      await fs.promises.rename(tmp, file);
    }).catch(e => console.warn('[file] save failed:', e.message));
    return writing;
  };
  const save = () => { clearTimeout(timer); timer = setTimeout(flush, 300); };
  const byId = id => d.users.find(u => u.id === id);
  const pub = u => u && { id: u.id, name: u.name, nick: u.nick || null, key: u.key, salt: u.salt, hash: u.hash,
    level: u.level, stars: u.stars, updated: u.updated, save: u.save, seen: u.seen || 0 };
  const hasF = (a, b) => d.friends.some(f => f[0] === a && f[1] === b);
  return {
    async init() {
      try { d = Object.assign(d, JSON.parse(await fs.promises.readFile(file, 'utf8'))); }
      catch (e) { if (e.code !== 'ENOENT') console.warn('[file] could not read', file, e.message); }
    },
    flush,
    async createUser(u) {
      if (d.users.some(x => x.key === u.key)) return null;
      const id = d.nextUser++;
      d.users.push({ id, name: u.name, key: u.key, salt: u.salt, hash: u.hash, level: 1, stars: 0, save: null,
        updated: u.now, created: u.now, nick: null, nick_key: null, seen: 0 });
      save(); return id;
    },
    async userByKey(k) { return pub(d.users.find(u => u.key === k)); },
    async userByNick(k) { return pub(d.users.find(u => u.nick_key === k)); },
    async setNick(id, nick, key) {
      if (d.users.some(u => u.nick_key === key && u.id !== id)) return false;
      const u = byId(id); if (!u) return false;
      u.nick = nick; u.nick_key = key; save(); return true;
    },
    async addSession(h, id) { d.sessions[h] = { id, at: Date.now() }; save(); },
    async userBySession(h) { const s = d.sessions[h]; return s ? pub(byId(s.id)) : undefined; },
    async delSession(h) { delete d.sessions[h]; save(); },
    async setSave(id, sv, level, stars, updated) {
      const u = byId(id); if (!u) return;
      u.save = sv; u.level = level; u.stars = stars; u.updated = updated; save();
    },
    async top(n) { return d.users.map(pub).sort(cmp).slice(0, n); },
    async rank(u) { return d.users.filter(x => cmp(pub(x), u) < 0).length + 1; },
    async friends(id) { return d.friends.filter(f => f[0] === id).map(f => pub(byId(f[1]))).filter(Boolean); },
    async addFriend(id, fid) { if (!hasF(id, fid)) { d.friends.push([id, fid]); save(); } },
    async delFriend(id, fid) { d.friends = d.friends.filter(f => !(f[0] === id && f[1] === fid)); save(); },
    async hasFriend(id, fid) { return hasF(id, fid); },
    async touch(id, now) { const u = byId(id); if (u) { u.seen = now; save(); } },
    async addRequest(from, to) {
      if (!d.requests.some(r => r.from === from && r.to === to)) { d.requests.push({ from, to, at: Date.now() }); save(); }
    },
    async delRequest(from, to) {
      const n = d.requests.length;
      d.requests = d.requests.filter(r => !(r.from === from && r.to === to));
      if (d.requests.length !== n) save();
      return d.requests.length !== n;
    },
    async hasRequest(from, to) { return d.requests.some(r => r.from === from && r.to === to); },
    async requestsTo(id) {
      return d.requests.filter(r => r.to === id).sort((a, b) => b.at - a.at).slice(0, 50)
        .map(r => Object.assign(pub(byId(r.from)) || {}, { at: r.at })).filter(x => x.id);
    },
    async requestsFrom(id) { return d.requests.filter(r => r.from === id).map(r => pub(byId(r.to))).filter(Boolean); },
    async addMail(to, from, kind, body) {
      d.mail.push({ id: d.nextMail++, to, from, kind, body, at: Date.now(), read: false, claimed: false });
      const mine = d.mail.filter(m => m.to === to).sort((a, b) => b.id - a.id);
      if (mine.length > 100) { const drop = new Set(mine.slice(100).map(m => m.id)); d.mail = d.mail.filter(m => !drop.has(m.id)); }
      save();
    },
    async mailFor(id) {
      return d.mail.filter(m => m.to === id).sort((a, b) => b.id - a.id).slice(0, 100).map(m => {
        const f = m.from && byId(m.from);
        return { id: m.id, kind: m.kind, body: m.body, at: m.at, read: m.read, claimed: m.claimed, fromName: f ? (f.nick || f.name) : null };
      });
    },
    async claimMail(id, uid) {
      const m = d.mail.find(x => x.id === id && x.to === uid && !x.claimed && x.kind === 'gift');
      if (!m) return null;
      m.claimed = true; m.read = true; save(); return m.body;
    },
    async giftCounts(from, to, since) {
      const l = d.mail.filter(m => m.from === from && m.kind === 'gift' && m.at >= since);
      return { pair: l.filter(m => m.to === to).length, total: l.length };
    },
    async readMail(id, uid) { const m = d.mail.find(x => x.id === id && x.to === uid); if (m) { m.read = true; save(); } },
    async delMail(id, uid) { d.mail = d.mail.filter(m => !(m.id === id && m.to === uid)); save(); }
  };
}

/* ---------------- helpers ---------------- */
const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL)
  : fileStore(process.env.DATA_FILE || path.join(__dirname, 'data.json'));
let ready = false;

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const normKey = s => String(s).normalize('NFC').toLowerCase();
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex');
const isOnline = u => Date.now() - (u.seen || 0) < ONLINE_MS;
const publicName = u => u.nick || u.name;
const HttpErr = (status, error) => Object.assign(new Error(error), { status, error });

function send(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY) { reject(HttpErr(413, 'ข้อมูลใหญ่เกินไป')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); }
      catch (e) { reject(HttpErr(400, 'ข้อมูลไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}

/* very small in-memory rate limit for login/register (per IP) */
const tries = new Map();
function limited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(), e = tries.get(ip);
  if (!e || now - e.t > 10 * 60 * 1000) { tries.set(ip, { t: now, n: 1 }); return false; }
  return ++e.n > 40;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of tries) if (now - v.t > 10 * 60 * 1000) tries.delete(k); }, 10 * 60 * 1000).unref();

async function auth(req) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.authorization || '');
  if (!m) throw HttpErr(401, 'กรุณาเข้าสู่ระบบ');
  const u = await store.userBySession(sha(m[1].toLowerCase()));
  if (!u) throw HttpErr(401, 'หมดเวลาเข้าสู่ระบบ');
  req.tokenHash = sha(m[1].toLowerCase());
  return u;
}
async function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  await store.addSession(sha(token), uid);
  return token;
}
/* find a player by username or nickname */
async function findPlayer(s) {
  s = String(s || '').trim();
  if (!s || s.length > 40) return null;
  const k = normKey(s);
  return (await store.userByKey(k)) || (await store.userByNick(k)) || null;
}
const meInfo = u => ({ name: u.name, nick: u.nick, level: u.level, stars: u.stars, save: u.save });
const lbRow = (u, rank, me, friendIds) => ({ rank, user: u.name, name: publicName(u), level: u.level, stars: u.stars,
  online: u.id === me.id ? true : isOnline(u), me: u.id === me.id, friend: friendIds.has(u.id) });

function cleanSave(sv) {
  if (!sv || typeof sv !== 'object' || Array.isArray(sv)) throw HttpErr(400, 'ข้อมูลเซฟไม่ถูกต้อง');
  const level = Math.min(MAX_LEVEL, Math.max(1, Math.floor(+sv.unlocked) || 1));
  let stars = 0;
  if (sv.stars && typeof sv.stars === 'object') {
    for (const k of Object.keys(sv.stars)) {
      const lv = +k, v = Math.floor(+sv.stars[k]) || 0;
      if (lv >= 1 && lv <= level && v > 0) stars += Math.min(3, v);
    }
  }
  return { level, stars };
}

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const p = url.pathname, M = req.method;
  if (p === '/api/health') return send(res, 200, { ok: true, ready });
  if (!ready) return send(res, 503, { error: 'เซิร์ฟเวอร์กำลังเริ่มทำงาน ลองใหม่อีกครั้ง' });

  if (M === 'POST' && (p === '/api/register' || p === '/api/login')) {
    if (limited(req)) throw HttpErr(429, 'ลองบ่อยเกินไป รอสักครู่แล้วลองใหม่');
    const b = await readBody(req);
    const name = String(b.username || '').trim(), pw = String(b.password || '');
    if (p === '/api/register') {
      if (!NAME_RE.test(name)) throw HttpErr(400, 'ชื่อผู้ใช้ต้องยาว 3–20 ตัว ใช้ตัวอักษร ตัวเลข _ . - ได้เท่านั้น');
      if (pw.length < 6 || pw.length > 100) throw HttpErr(400, 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
      const key = normKey(name);
      if (await store.userByNick(key)) throw HttpErr(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
      const salt = crypto.randomBytes(16).toString('hex');
      const id = await store.createUser({ name, key, salt, hash: await hashPw(pw, salt), now: Date.now() });
      if (!id) throw HttpErr(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
      const token = await newSession(id);
      return send(res, 200, { token, name, nick: null, save: null, level: 1, stars: 0 });
    }
    const u = name && pw ? await store.userByKey(normKey(name)) : null;
    const ok = u && crypto.timingSafeEqual(Buffer.from(await hashPw(pw, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
    if (!ok) throw HttpErr(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    const token = await newSession(u.id);
    await store.touch(u.id, Date.now());
    return send(res, 200, Object.assign({ token }, meInfo(u)));
  }

  const me = await auth(req);

  if (M === 'POST' && p === '/api/logout') { await store.delSession(req.tokenHash); return send(res, 200, { ok: true }); }
  if (M === 'GET' && p === '/api/me') { await store.touch(me.id, Date.now()); return send(res, 200, meInfo(me)); }

  if (M === 'PUT' && p === '/api/save') {
    const b = await readBody(req), { level, stars } = cleanSave(b.save);
    if (level < me.level) throw HttpErr(409, 'เซฟบนเซิร์ฟเวอร์ใหม่กว่า');
    const now = Date.now();
    await store.setSave(me.id, b.save, level, stars, (level === me.level && stars === me.stars) ? me.updated : now);
    await store.touch(me.id, now);
    return send(res, 200, { ok: true, level, stars });
  }

  if (M === 'PUT' && p === '/api/nick') {
    const b = await readBody(req), nick = String(b.nick || '').trim().replace(/\s+/g, ' ');
    if (!NICK_RE.test(nick)) throw HttpErr(400, 'ชื่อต้องยาว 2–16 ตัว ใช้ตัวอักษร ตัวเลข ช่องว่าง _ . - ได้เท่านั้น');
    const key = normKey(nick), other = await store.userByKey(key);
    if (other && other.id !== me.id) throw HttpErr(409, 'ชื่อนี้ถูกใช้แล้ว');
    if (!(await store.setNick(me.id, nick, key))) throw HttpErr(409, 'ชื่อนี้ถูกใช้แล้ว');
    return send(res, 200, { nick });
  }

  if (M === 'GET' && p === '/api/leaderboard') {
    await store.touch(me.id, Date.now());
    const [top, friends, pending, rank] = await Promise.all([store.top(50), store.friends(me.id), store.requestsFrom(me.id), store.rank(me)]);
    const fids = new Set(friends.map(f => f.id));
    const topRows = top.map((u, i) => lbRow(u, i + 1, me, fids));
    const mine = Object.assign(lbRow(me, rank, me, fids), { friend: false });
    const board = friends.concat([me]).sort(cmp).map((u, i) => lbRow(u, i + 1, me, fids));
    return send(res, 200, {
      top: topRows, me: mine,
      friends: friends.map(u => ({ user: u.name, name: publicName(u), level: u.level, stars: u.stars, online: isOnline(u) })),
      friendsBoard: board,
      pending: pending.map(u => ({ user: u.name, name: publicName(u) }))
    });
  }

  if (M === 'POST' && p === '/api/friends') {
    const b = await readBody(req), t = await findPlayer(b.name);
    if (!t) throw HttpErr(404, 'ไม่พบผู้เล่นชื่อนี้');
    if (t.id === me.id) throw HttpErr(400, 'เพิ่มตัวเองเป็นเพื่อนไม่ได้');
    const name = publicName(t);
    if (await store.hasFriend(me.id, t.id)) return send(res, 200, { status: 'already', name });
    if ((await store.friends(me.id)).length >= MAX_FRIENDS) throw HttpErr(400, 'มีเพื่อนครบ ' + MAX_FRIENDS + ' คนแล้ว');
    if (await store.delRequest(t.id, me.id)) {          // they asked first -> friends right away
      await store.addFriend(me.id, t.id); await store.addFriend(t.id, me.id);
      return send(res, 200, { status: 'friends', name });
    }
    await store.addRequest(me.id, t.id);
    return send(res, 200, { status: 'sent', name });
  }

  if (M === 'POST' && (p === '/api/friends/accept' || p === '/api/friends/decline')) {
    const b = await readBody(req), t = await findPlayer(b.user);
    if (!t || !(await store.delRequest(t.id, me.id))) throw HttpErr(404, 'ไม่พบคำขอนี้ (อาจถูกยกเลิกแล้ว)');
    if (p.endsWith('/accept')) {
      if ((await store.friends(me.id)).length >= MAX_FRIENDS) throw HttpErr(400, 'มีเพื่อนครบ ' + MAX_FRIENDS + ' คนแล้ว');
      await store.addFriend(me.id, t.id); await store.addFriend(t.id, me.id);
    }
    return send(res, 200, { ok: true, name: publicName(t) });
  }

  let m;
  if (M === 'DELETE' && (m = /^\/api\/friends\/(.+)$/.exec(p))) {
    const t = await findPlayer(decodeURIComponent(m[1]));
    if (t) { await store.delFriend(me.id, t.id); await store.delFriend(t.id, me.id); }
    return send(res, 200, { ok: true });
  }

  if (M === 'GET' && p === '/api/ping') {
    await store.touch(me.id, Date.now());
    const [mail, reqs] = await Promise.all([store.mailFor(me.id), store.requestsTo(me.id)]);
    return send(res, 200, { mail: mail.filter(x => !x.read || (x.kind === 'gift' && !x.claimed)).length, requests: reqs.length });
  }

  if (M === 'GET' && p === '/api/mailbox') {
    const [mail, reqs] = await Promise.all([store.mailFor(me.id), store.requestsTo(me.id)]);
    return send(res, 200, {
      requests: reqs.map(u => ({ user: u.name, name: publicName(u), level: u.level, online: isOnline(u), at: u.at })),
      mail: mail.map(x => ({ id: x.id, from: x.fromName, gift: x.kind === 'gift' && x.body ? x.body.gift : undefined,
        text: x.body && x.body.text, at: x.at, read: x.read, claimed: x.claimed }))
    });
  }

  if (M === 'POST' && p === '/api/mail/send') {
    const b = await readBody(req), t = await findPlayer(b.user), g = b.gift || {};
    if (!t || t.id === me.id) throw HttpErr(404, 'ไม่พบผู้เล่นคนนี้');
    if (!(await store.hasFriend(me.id, t.id)) || !(await store.hasFriend(t.id, me.id)))
      throw HttpErr(403, 'ส่งของขวัญได้เฉพาะเพื่อนที่ตอบรับกันแล้ว');
    let gift;
    if (g.type === 'heart' && +g.n === 1) gift = { type: 'heart', n: 1 };
    else if (g.type === 'coin' && GIFT_COINS.includes(+g.n)) gift = { type: 'coin', n: +g.n };
    else if (g.type === 'item' && +g.n === 1 && GIFT_ITEMS.includes(g.item)) gift = { type: 'item', n: 1, item: g.item };
    else throw HttpErr(400, 'ของขวัญไม่ถูกต้อง');
    const c = await store.giftCounts(me.id, t.id, Date.now() - DAY);
    if (c.pair >= GIFT_PER_FRIEND) throw HttpErr(429, 'วันนี้ส่งให้เพื่อนคนนี้ครบ ' + GIFT_PER_FRIEND + ' ชิ้นแล้ว');
    if (c.total >= GIFT_PER_DAY) throw HttpErr(429, 'วันนี้ส่งของขวัญครบ ' + GIFT_PER_DAY + ' ชิ้นแล้ว');
    const text = String(b.msg || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    await store.addMail(t.id, me.id, 'gift', { gift, text });
    return send(res, 200, { ok: true });
  }

  if ((m = /^\/api\/mail\/(\d+)(?:\/(claim|read))?$/.exec(p))) {
    const id = +m[1];
    if (M === 'POST' && m[2] === 'claim') {
      const body = await store.claimMail(id, me.id);
      if (!body || !body.gift) throw HttpErr(409, 'รับของขวัญนี้ไปแล้วหรือไม่พบจดหมาย');
      return send(res, 200, { gift: body.gift });
    }
    if (M === 'POST' && m[2] === 'read') { await store.readMail(id, me.id); return send(res, 200, { ok: true }); }
    if (M === 'DELETE' && !m[2]) { await store.delMail(id, me.id); return send(res, 200, { ok: true }); }
  }

  throw HttpErr(404, 'ไม่พบ API นี้');
}

/* ---------------- static files ---------------- */
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const zcache = new Map();
async function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (file !== PUB && !file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  let st;
  try { st = await fs.promises.stat(file); if (st.isDirectory()) throw 0; }
  catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
  if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
  let data = await fs.promises.readFile(file);
  if (/^(text\/|application\/(json|javascript)|image\/svg)/.test(headers['Content-Type']) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const k = file + ':' + st.mtimeMs;
    let z = zcache.get(k);
    if (!z) { z = require('zlib').gzipSync(data); if (zcache.size > 50) zcache.clear(); zcache.set(k, z); }
    data = z; headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(200, headers);
  res.end(data);
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return await serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e && e.status) return send(res, e.status, { error: e.error });
    console.error('[error]', req.method, req.url, e);
    send(res, 500, { error: 'เซิร์ฟเวอร์ขัดข้อง ลองใหม่อีกครั้ง' });
  }
});
server.keepAliveTimeout = 65000;

/* listen first so Render sees the open port, then connect to the database (retrying if it is still waking up) */
server.listen(PORT, '0.0.0.0', () => console.log('Sweet Market listening on ' + PORT + (process.env.DATABASE_URL ? ' (Postgres)' : ' (JSON file)')));
(async function boot() {
  for (let i = 1; ; i++) {
    try { await store.init(); ready = true; console.log('Storage ready'); return; }
    catch (e) { console.error('[storage] init failed (try ' + i + '):', e.message); await new Promise(r => setTimeout(r, Math.min(15000, 2000 * i))); }
  }
})();

/* keep the free Render instance awake: ping our own /api/health every 10 minutes */
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') + '/api/health', { signal: AbortSignal.timeout(30000) })
      .catch(e => console.warn('[keepalive]', e.message));
  }, 10 * 60 * 1000).unref();
}

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
const bye = () => { server.close(); Promise.resolve(store.flush && store.flush()).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);
