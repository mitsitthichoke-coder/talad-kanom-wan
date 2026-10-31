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
const GIFT_COINS =, GIFT_ITEMS = ['hammer', 'mortar', 'fan', 'lantern', 'shuffle', 'moves'];
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
    async delMail(id, uid) { await q("delete from mail where id=$1 and to_id=$2", [id, uid]); }
  };
}
