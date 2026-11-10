'use strict';
/*
 * sources.js - turn what the user pasted into something ffmpeg can open.
 *
 *   a direct stream (HLS .m3u8, .ts, .mp4 ...)   -> passed through
 *   an ordinary web page with a video on it      -> scanned for the stream it already names
 *                                                    (extract.js) - works for plain video pages
 *                                                    and many embed/IPTV players, not for a
 *                                                    player a page only builds with JavaScript,
 *                                                    and never for anything sign-in or DRM gated
 *   a YouTube link                                -> not supported: YouTube only hands its streams
 *                                                    to signed-in viewers in its own players
 *
 * resolve(source) -> Promise<{ input, inputArgs }>
 */

const extract = require('./extract');

function isYoutube(u) {
  return /^(ytdlp:)?https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(String(u).trim());
}

// already names a stream/container - nothing to go looking for, hand it to ffmpeg as-is
function looksLikeStream(u) {
  return /\.(m3u8|mpd|ts|mp4|mkv|webm|flv|mov|aac|mp3|m4a)(\?|#|$)/i.test(u) || /\/(playlist|manifest|chunklist)(\?|$)/i.test(u);
}

function resolve(source) {
  const src = String(source || '').trim();
  if (isYoutube(src)) return Promise.reject(new Error('YouTube links are not supported - use a direct stream or playlist'));
  if (/^ytdlp:/i.test(src)) return Promise.reject(new Error('Only direct stream and playlist addresses work'));
  if (!/^https?:\/\//i.test(src) || looksLikeStream(src)) return Promise.resolve({ input: src, inputArgs: [] });
  // an ordinary web page: look for the video it already points to, rather than assume it IS one
  return extract.resolve(src).then(function (stream) { return { input: stream, inputArgs: [] }; })
    .catch(function (e) { throw new Error('Could not play that page - ' + e.message); });
}

module.exports = { resolve: resolve, isYoutube: isYoutube };
