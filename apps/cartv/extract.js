'use strict';
/*
 * extract.js - find a direct, playable stream inside an ordinary web page.
 *
 * There's no JS engine here (way too heavy for this unit - no room, no spare CPU), so this only
 * finds a stream the page's own HTML already names: a <video>/<source> tag, an og:video tag, or
 * a player config with a .m3u8/.mpd/.mp4 URL written straight into the page or an inline script.
 * That covers plain video pages and a lot of embed/IPTV-aggregator players. It will not find a
 * stream a page only builds by running JavaScript, and it does not try to get past a sign-in
 * wall, a bot-check, or DRM - those stay out of reach on purpose, the same line drawn for YouTube
 * in sources.js.
 *
 * resolve(pageUrl) -> Promise<streamUrl>
 */

const urlmod = require('url');
const netx = require('./netx');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function abs(base, u) {
  try { return urlmod.resolve(base, u); } catch (e) { return u; }
}

// a manifest/page that names DRM (Widevine/PlayReady/FairPlay) will not play without a license
// server this app doesn't have - fail clearly instead of handing ffmpeg something that can only
// error out, and don't go looking for a way around it.
function isDrm(u) {
  return /widevine|playready|fairplay/i.test(u);
}

function fetchPage(u) {
  return netx.request('GET', u, null, {
    timeout: 15000, maxBytes: 4 * 1024 * 1024, redirects: 5,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
  }).then(function (r) {
    if (r.status >= 400) throw new Error('http ' + r.status + ' fetching the page');
    return r.body;
  });
}

function candidates(html, pageUrl) {
  const found = [];
  const push = function (u) { if (!u) return; u = abs(pageUrl, u); if (found.indexOf(u) < 0) found.push(u); };
  let m;

  const videoTag = /<(?:video|source)[^>]+src=["']([^"']+)["']/ig;
  while ((m = videoTag.exec(html))) push(m[1]);

  const og = /<meta[^>]+property=["']og:video(?::url|:secure_url)?["'][^>]+content=["']([^"']+)["']/ig;
  while ((m = og.exec(html))) push(m[1]);

  // an absolute manifest/media URL written straight into the page or an inline script
  const direct = /https?:\/\/[^"'\\\s<>]+\.(?:m3u8|mpd)(?:\?[^"'\\\s<>]*)?/ig;
  while ((m = direct.exec(html))) push(m[0]);

  // common player-config fields: file/src/source/hls/manifest: "....m3u8"
  const field = /["'](?:file|src|source|hls|manifest|url)["']\s*:\s*["']([^"']+\.(?:m3u8|mpd)[^"']*)["']/ig;
  while ((m = field.exec(html))) push(m[1]);

  const iframes = [];
  const ifr = /<iframe[^>]+src=["']([^"']+)["']/ig;
  while ((m = ifr.exec(html))) { const u = abs(pageUrl, m[1]); if (/^https?:\/\//i.test(u)) iframes.push(u); }

  return { found: found, iframes: iframes };
}

function resolve(pageUrl, depth) {
  depth = depth || 0;
  return fetchPage(pageUrl).then(function (html) {
    const c = candidates(html, pageUrl);
    const safe = c.found.filter(function (u) { return !isDrm(u); });
    if (c.found.length && !safe.length) throw new Error('that page uses DRM-protected video, so it will not play here');
    if (safe.length) {
      // a manifest (.m3u8/.mpd) is a safer bet than a bare .mp4 someone linked for a download button
      safe.sort(function (a, b) { return (/\.(m3u8|mpd)/i.test(b) ? 1 : 0) - (/\.(m3u8|mpd)/i.test(a) ? 1 : 0); });
      return safe[0];
    }
    if (c.iframes.length && depth < 1) return resolve(c.iframes[0], depth + 1);
    throw new Error('could not find a playable video on that page (it may build the player with JavaScript)');
  });
}

module.exports = { resolve: resolve };
