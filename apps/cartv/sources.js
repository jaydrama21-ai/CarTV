'use strict';
/*
 * sources.js - turn what the user pasted into something ffmpeg can open.
 *
 *   a direct stream (HLS .m3u8, .ts, .mp4 ...)   -> passed through
 *   a YouTube link                               -> not supported: YouTube only hands its streams to
 *                                                   signed-in viewers in its own players
 *
 * resolve(source) -> Promise<{ input, inputArgs }>
 */

function isYoutube(u) {
  return /^(ytdlp:)?https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(String(u).trim());
}

function resolve(source) {
  const src = String(source || '').trim();
  if (isYoutube(src)) return Promise.reject(new Error('YouTube links are not supported - use a direct stream or playlist'));
  if (/^ytdlp:/i.test(src)) return Promise.reject(new Error('Only direct stream and playlist addresses work'));
  return Promise.resolve({ input: src, inputArgs: [] });
}

module.exports = { resolve: resolve, isYoutube: isYoutube };
