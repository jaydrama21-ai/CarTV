'use strict';
/*
 * sources.js - turn a user-facing source into an ffmpeg input.
 *
 *   file / http(s) / m3u8 (HLS)  -> passthrough (ffmpeg reads it directly)
 *   ytdlp:<url>                  -> resolve a direct media URL with yt-dlp -g
 *                                   (covers YouTube + ~1800 sites). Video+audio
 *                                   may resolve to two URLs; we return the video
 *                                   URL and note the audio URL for later.
 *
 * resolve() is async and returns { input, inputArgs, audioUrl? }.
 */

const { spawn } = require('child_process');

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (err += b));
    p.on('error', rej);
    p.on('exit', (c) => (c === 0 ? res(out.trim()) : rej(new Error(`${cmd} exit ${c}: ${err.trim().slice(-300)}`))));
  });
}

async function resolve(source, opts = {}) {
  const ytdlp = opts.ytdlp || 'yt-dlp';
  const maxH = opts.maxHeight || 720;

  if (source.startsWith('ytdlp:')) {
    const url = source.slice('ytdlp:'.length);
    // prefer a single progressive stream <= maxH (one URL, has audio); fall back to bestvideo
    const fmt = `best[height<=?${maxH}][vcodec!=none][acodec!=none]/best[height<=?${maxH}]/best`;
    const urls = (await run(ytdlp, ['-f', fmt, '-g', '--no-warnings', url])).split('\n').filter(Boolean);
    if (!urls.length) throw new Error('yt-dlp returned no URL');
    return { input: urls[0], inputArgs: [], audioUrl: urls[1] || null };
  }
  // direct file/URL/HLS
  return { input: source, inputArgs: [] };
}

module.exports = { resolve };
