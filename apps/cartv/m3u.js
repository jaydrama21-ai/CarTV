'use strict';
/*
 * m3u.js - parse an M3U / M3U8 playlist into channels, and fetch one over http.
 *
 *   #EXTM3U
 *   #EXTINF:-1 tvg-id="x" tvg-logo="http://..." group-title="News",CNN
 *   http://host/stream/cnn.m3u8
 *
 * parse(text)  -> [{ name, url, group, logo }]
 * fetch(url)   -> Promise<string>   (node http(s); used on the head unit)
 */

function parse(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  let pending = null;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',');
      const name = comma >= 0 ? line.slice(comma + 1).trim() : '';
      const attr = (k) => { const m = line.match(new RegExp(k + '="([^"]*)"', 'i')); return m ? m[1] : ''; };
      pending = { name: name || 'Channel', group: attr('group-title'), logo: attr('tvg-logo') };
    } else if (line.startsWith('#')) {
      // other directives (#EXTVLCOPT, #EXTGRP, etc.) - keep group if given
      if (pending && /^#EXTGRP:/i.test(line)) pending.group = line.slice(8).trim();
    } else {
      // a URL line
      const ch = pending || { name: 'Channel ' + (out.length + 1), group: '', logo: '' };
      ch.url = line;
      out.push(ch);
      pending = null;
    }
  }
  return out;
}

function fetch(url, opts = {}) {
  const mod = url.startsWith('https:') ? require('https') : require('http');
  const timeout = opts.timeout || 15000;
  return new Promise((res, rej) => {
    const req = mod.get(url, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return res(fetch(require('url').resolve(url, r.headers.location), opts));
      }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('http ' + r.statusCode + ' for ' + url)); }
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c) => (body += c));
      r.on('end', () => res(body));
    });
    req.on('error', rej);
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout fetching ' + url)); });
  });
}

/** Load channels from a playlist URL, a raw m3u string, or a single direct stream URL. */
async function load(src) {
  if (!src) return [];
  if (/^#EXTM3U/i.test(src.trim())) return parse(src);
  if (/^https?:\/\//i.test(src) && /\.m3u8?(\?|$)/i.test(src) === false && /get\.php|type=m3u|\/playlist/i.test(src)) {
    // looks like a playlist endpoint (Xtream get.php, etc.)
    return parse(await fetch(src));
  }
  if (/^https?:\/\//i.test(src) && /\.m3u(\?|$)/i.test(src)) {
    return parse(await fetch(src));
  }
  // a single direct stream (including a direct .m3u8 HLS stream) or ytdlp: URL
  return [{ name: 'Stream', url: src, group: '', logo: '' }];
}

module.exports = { parse, fetch, load };
