'use strict';
/*
 * sources.js - turn what the user pasted into something ffmpeg can open.
 *
 *   a direct stream (HLS .m3u8, .ts, .mp4 ...)   -> passed through
 *   a YouTube link (youtu.be/..., youtube.com/watch?v=..., /shorts/, /live/) -> EXPERIMENTAL:
 *       asks YouTube's player API for the video's stream addresses and picks one. YouTube changes
 *       this often and may refuse; the error then says so.
 *
 * resolve(source, { maxHeight }) -> Promise<{ input, inputArgs, title? }>
 */

const netx = require('./netx');

function youtubeId(u) {
  const s = String(u).replace(/^ytdlp:/i, '').trim();
  let m = /^https?:\/\/(?:www\.)?youtu\.be\/([\w-]{11})/i.exec(s);
  if (m) return m[1];
  if (!/^https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\//i.test(s)) return null;
  m = /[?&]v=([\w-]{11})/.exec(s) || /\/(?:shorts|live|embed|v)\/([\w-]{11})/.exec(s);
  return m ? m[1] : null;
}

// the client YouTube's own VR app identifies as: its answers carry plain stream addresses
const YT_CLIENT = {
  clientName: 'ANDROID_VR', clientVersion: '1.60.19', deviceMake: 'Oculus', deviceModel: 'Quest 3',
  androidSdkVersion: 32, osName: 'Android', osVersion: '12L', hl: 'en', gl: 'US',
  userAgent: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
};

function youtube(id, maxHeight) {
  const body = JSON.stringify({ context: { client: YT_CLIENT }, videoId: id, contentCheckOk: true, racyCheckOk: true });
  return netx.request('POST', 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', body, {
    timeout: 20000,
    headers: {
      'Content-Type': 'application/json', 'User-Agent': YT_CLIENT.userAgent,
      'X-YouTube-Client-Name': '28', 'X-YouTube-Client-Version': YT_CLIENT.clientVersion, Origin: 'https://www.youtube.com',
    },
  }).then(function (r) {
    if (r.status !== 200) throw new Error('YouTube answered ' + r.status);
    let j;
    try { j = JSON.parse(r.body); } catch (e) { throw new Error('YouTube sent something unreadable'); }
    const ps = j.playabilityStatus || {};
    if (ps.status && ps.status !== 'OK') throw new Error('YouTube: ' + (ps.reason || ps.status));
    const sd = j.streamingData || {};
    const title = (j.videoDetails && j.videoDetails.title) || 'YouTube';
    if (sd.hlsManifestUrl) return { input: sd.hlsManifestUrl, inputArgs: [], title: title };   // live
    const ok = function (f) { return f && f.url && f.mimeType; };
    // picture and sound in one file first (so sound can follow later), best that fits
    const both = (sd.formats || []).filter(ok).filter(function (f) { return (f.height || 0) <= maxHeight; })
      .sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
    if (both.length) return { input: both[0].url, inputArgs: [], title: title };
    const video = (sd.adaptiveFormats || []).filter(ok).filter(function (f) {
      return /^video\/mp4/.test(f.mimeType) && /avc1/.test(f.mimeType) && (f.height || 0) <= maxHeight;
    }).sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
    if (video.length) return { input: video[0].url, inputArgs: [], title: title };
    throw new Error('YouTube gave no playable stream for this video');
  });
}

function resolve(source, opts) {
  opts = opts || {};
  const src = String(source || '').trim();
  const id = youtubeId(src);
  if (id) return youtube(id, opts.maxHeight || 720);
  if (/^ytdlp:/i.test(src)) return Promise.reject(new Error('Only YouTube links and direct stream addresses work'));
  return Promise.resolve({ input: src, inputArgs: [] });
}

module.exports = { resolve: resolve, youtubeId: youtubeId };
