'use strict';
/*
 * relay.js - the phone remote, over a relay, because nothing can connect IN to the head unit.
 *
 * The unit's firewall drops every incoming connection to an app, so the app cannot serve a page to
 * the phone. Instead both sides talk OUT to a public message relay (ntfy.sh): the phone page posts
 * to one topic, the app polls it; the app answers on a second topic the phone page polls.
 *
 * Topic names and the encryption key both come from the pairing code shown on the car's screen, and
 * every message is AES-256-GCM encrypted with that key, so the relay only ever holds ciphertext.
 *
 *   topic in  = 'cartv' + sha256('in:'  + code)[0..40]     phone -> car
 *   topic out = 'cartv' + sha256('out:' + code)[0..40]     car -> phone
 *   key       = sha256('cartv-key:' + code)
 *   message   = base64( iv(12) | ciphertext | tag(16) ) of a JSON object
 *
 * Written for the unit's old Node (8): no modern syntax, plain http/https.
 */

const crypto = require('crypto');
const netx = require('./netx');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1

function newCode() {
  const b = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}
function pretty(code) { return code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8); }
function clean(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function sha(s) { return crypto.createHash('sha256').update(s, 'utf8').digest(); }
function topics(code) {
  return {
    in: 'cartv' + sha('in:' + code).toString('hex').slice(0, 40),
    out: 'cartv' + sha('out:' + code).toString('hex').slice(0, 40),
    key: sha('cartv-key:' + code),
  };
}

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64');
}
function open(key, b64) {
  const raw = Buffer.from(String(b64), 'base64');
  if (raw.length < 29) throw new Error('short message');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.slice(0, 12));
  d.setAuthTag(raw.slice(raw.length - 16));
  const body = Buffer.concat([d.update(raw.slice(12, raw.length - 16)), d.final()]);
  return JSON.parse(body.toString('utf8'));
}

function request(method, url, body, timeout) {
  return netx.request(method, url, body, { timeout: timeout || 15000, maxBytes: 2000000 }).then(function (r) {
    if (r.status >= 200 && r.status < 300) return r.body;
    throw new Error('relay answered ' + r.status);
  });
}

/**
 * start({ base, code, log, onMessage(obj) }) -> { send(obj), sendText(kind, text), state() }
 * Polls the in-topic; the first successful poll only notes where the topic stands (commands sent
 * while the app was closed are not replayed).
 */
function start(opts) {
  const base = (opts.base || 'https://ntfy.sh').replace(/\/$/, '');
  const t = topics(opts.code);
  const log = opts.log || function () {};
  let since = null;          // id of the last message seen; null until the first poll drained the topic
  let ok = false, lastError = '', busy = false, stopped = false;

  function poll() {
    if (busy || stopped) return;
    busy = true;
    request('GET', base + '/' + t.in + '/json?poll=1&since=' + (since || 'all'), null, 20000).then(function (text) {
      const first = since === null;
      const lines = text.split('\n');
      const todo = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let m;
        try { m = JSON.parse(lines[i]); } catch (e) { continue; }
        if (m.event !== 'message' || !m.id) continue;
        since = m.id;
        if (first) continue;   // draining what was there before the app started
        let obj;
        try { obj = open(t.key, m.message); } catch (e) { log('phone message not readable (wrong code?)'); continue; }
        todo.push(obj);
      }
      // one at a time, each finished before the next (a new playlist is loaded before "play" is handled)
      todo.reduce(function (chain, obj) {
        return chain.then(function () { return opts.onMessage(obj); }).catch(function (e) { log('phone message failed: ' + e.message); });
      }, Promise.resolve());
      if (first && since === null) since = String(Math.floor(Date.now() / 1000) - 60); // empty topic
      if (!ok) log('phone remote connected');
      ok = true; lastError = '';
    }).catch(function (e) {
      if (ok || lastError !== e.message) log('phone remote: ' + e.message);
      ok = false; lastError = e.message;
    }).then(function () { busy = false; });
  }
  const timer = setInterval(poll, opts.intervalMs || 6000);
  poll();

  function send(obj) {
    return request('POST', base + '/' + t.out, seal(t.key, obj), 15000).catch(function (e) { log('phone reply not sent: ' + e.message); });
  }
  // long text (diagnostics, the log) goes in pieces that fit the relay's message size
  function sendText(kind, text) {
    const parts = [];
    for (let i = 0; i < text.length; i += 1800) parts.push(text.slice(i, i + 1800));
    if (!parts.length) parts.push('');
    const stamp = Date.now();
    let chain = Promise.resolve();
    parts.forEach(function (p, i) {
      chain = chain.then(function () { return send({ t: 'text', k: kind, s: stamp, i: i, of: parts.length, v: p }); });
    });
    return chain;
  }
  return {
    send: send,
    sendText: sendText,
    state: function () { return { ok: ok, error: lastError }; },
    stop: function () { stopped = true; clearInterval(timer); },
  };
}

module.exports = { start: start, newCode: newCode, pretty: pretty, clean: clean, topics: topics, seal: seal, open: open };
