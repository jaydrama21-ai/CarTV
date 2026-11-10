'use strict';
/**
 * Car TV - live TV / IPTV and web video on the center screen.
 *
 * The head unit decodes the stream (ffmpeg) to RGBA frames and draws them on the
 * whole display, exactly the way the Doom app draws its frames (setImage + a
 * Recorder on the full-screen canvas). Picture only for now; audio is a setting
 * we wire later. Parked-only by default, off the car's speed signal.
 *
 * Screens:
 *   MAIN  menu: Play, Next channel, status line, settings (playlist URL, etc.)
 *   PLAY  the video alone on the whole screen; BACK returns, Channel -/+ retune.
 *
 * Source of channels: the "playlistUrl" setting - an m3u/Xtream playlist, or a
 * single stream/HLS URL, or a "ytdlp:<url>" to resolve YouTube and ~1800 sites.
 */

const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Recorder, setImage } = require('./kit/record');
const Parked = require('./kit/parked');
const { Player } = require('./player');
const sources = require('./sources');
const m3u = require('./m3u');
const diag = require('./diag');
const relay = require('./relay');
const netx = require('./netx');

const VID = 1;                 // image slot for the latest decoded frame
let DW = 960, DH = 540;       // decode size (16:9), from the Max resolution setting; the canvas scales it to the screen
const SIZES = { '480': [854, 480], '540': [960, 540], '720': [1280, 720] };

// the bundled static ffmpeg sits next to this file (build.py copies the asset into javascript/);
// fall back to one on PATH if the bundle is missing.
const BUNDLED_FFMPEG = path.join(__dirname, 'ffmpeg');
let FFMPEG = 'ffmpeg';
// make sure the bundle is runnable: the installer may drop the exec bit, and the app folder may be
// read-only, in which case a copy in the app's data folder is used instead.
function prepareFfmpeg(dataDir, log) {
  if (!fs.existsSync(BUNDLED_FFMPEG)) return;
  try { fs.accessSync(BUNDLED_FFMPEG, fs.constants.X_OK); FFMPEG = BUNDLED_FFMPEG; return; } catch (_) {}
  try { fs.chmodSync(BUNDLED_FFMPEG, 0o755); FFMPEG = BUNDLED_FFMPEG; return; } catch (_) {}
  try {
    const copy = path.join(dataDir, 'ffmpeg');
    if (!fs.existsSync(copy) || fs.statSync(copy).size !== fs.statSync(BUNDLED_FFMPEG).size) fs.copyFileSync(BUNDLED_FFMPEG, copy);
    fs.chmodSync(copy, 0o755);
    FFMPEG = copy;
  } catch (e) { log.warn('ffmpeg not runnable: ' + e.message); FFMPEG = BUNDLED_FFMPEG; }
}

mgu.run({
  async start(ctx) {
    const { ui, settings } = ctx;

    // keep the last lines of the log for the phone page
    const ring = [];
    const note = (lvl, msg) => {
      ring.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
      if (ring.length > 150) ring.shift();
      try { ctx.log[lvl](msg); } catch (e) { /* ignore */ }
    };
    const log = { info: (m) => note('info', m), warn: (m) => note('warn', m) };

    prepareFfmpeg(ctx.dataDir, log);
    // names resolve only through the uplink's lease; ffmpeg cannot do that, so it goes through a
    // small proxy in this process that can
    netx.init(ctx.dataDir);
    let proxyEnv = {};
    netx.startProxy((m) => log.warn(m)).then((port) => {
      const p = 'http://127.0.0.1:' + port;
      proxyEnv = { http_proxy: p, https_proxy: p, HTTP_PROXY: p, HTTPS_PROXY: p, no_proxy: '', NO_PROXY: '' };
      log.info('stream proxy on ' + p);
    }).catch((e) => log.warn('stream proxy not started: ' + e.message));
    const parked = Parked.watch(ctx, ctx.log);
    const blocked = () => settings.get('parkedOnly') !== false && parked.moving();

    // what the iDrive cannot take as text lives in a file the phone page edits
    const CONFIG = path.join(ctx.dataDir, 'cartv.json');
    let config = { source: '', audioDevice: 'default', audioBackend: 'alsa' };
    try { config = Object.assign(config, JSON.parse(fs.readFileSync(CONFIG, 'utf8'))); } catch (e) { /* first run */ }
    const saveConfig = () => { try { fs.writeFileSync(CONFIG, JSON.stringify(config)); } catch (e) { log.warn('config not saved: ' + e.message); } };

    let channels = [];
    let idx = 0;
    let player = null;
    let hasFrame = false, vw = DW, vh = DH;
    let status = 'Loading channels...';
    let paused = false;
    let diagLines = ['Not scanned yet'];

    const current = () => channels[idx] || null;

    async function loadChannels() {
      const src = (config.source || '').trim();
      try {
        channels = await m3u.load(src);
        status = channels.length ? 'Ready - press Play' : 'No playlist yet - add one from your phone';
      } catch (e) {
        channels = []; status = 'Playlist error: ' + e.message; log.warn('playlist: ' + e.message);
      }
      if (idx >= channels.length) idx = 0;
      log.info('playlist: ' + channels.length + ' channel(s)');
      menu();
    }

    function stopPlayer() {
      if (player) { player.stop(); player = null; }
      hasFrame = false;
    }

    async function startPlayer() {
      stopPlayer();
      const ch = current();
      if (!ch) { status = 'No channel'; return; }
      status = 'Tuning ' + (ch.name || ch.url) + '...';
      log.info('tuning ' + (ch.name || '') + ' ' + ch.url);
      let input = ch.url, inputArgs = [];
      try {
        const r = await sources.resolve(ch.url, { maxHeight: Number(settings.get('maxHeight')) || 540 });
        input = r.input; inputArgs = r.inputArgs || [];
      } catch (e) { status = e.message.slice(0, 90); log.warn('resolve: ' + e.message); return; }
      const size = SIZES[String(settings.get('maxHeight'))] || SIZES['540'];
      DW = size[0]; DH = size[1];
      const audioOn = settings.get('audio') === 'car';
      const p = new Player({
        ffmpeg: FFMPEG, env: proxyEnv,
        input, inputArgs, width: DW, height: DH, fps: 24, pixfmt: 'rgba',
        fit: settings.get('surface') === 'full' ? 'full' : 'fit',
        // sound to the car speakers (experimental): the device comes from the diagnostics
        audioDevice: audioOn ? (config.audioDevice || 'default') : null,
        audioBackend: config.audioBackend || 'alsa',
        onFrame: (buf) => {
          if (player !== p) return;
          if (!hasFrame) { status = 'Playing ' + (ch.name || ''); log.info('first frame'); }
          setImage(VID, DW, DH, buf); hasFrame = true; vw = DW; vh = DH;
        },
      });
      player = p;
      p.on('stall', () => { if (player === p && !hasFrame) status = 'Buffering...'; });
      p.on('error', (e) => { if (player === p) status = 'Error: ' + e.message; log.warn('player: ' + e.message); });
      p.on('exit', (code, err) => {
        log.info('ffmpeg exit ' + code + (err ? ': ' + err.slice(-400) : ''));
        if (player === p && code && err) {
          const last = err.split('\n').pop();
          status = /Invalid data found/.test(last) ? 'That link is a web page, not a video stream'
            : /40[134]|Forbidden|Not Found/.test(last) ? 'The stream refused the connection (' + (/(40\d)/.exec(last) || ['', 'error'])[1] + ')'
            : 'Stream failed: ' + last.replace(/^\[[^\]]*\]\s*/, '').slice(0, 70);
        }
      });
      p.on('end', () => {
        if (player !== p) return;
        if (ui.isVisible('PLAY') && !blocked() && !paused) setTimeout(() => { if (player === p) startPlayer(); }, 3000);
      });
      p.start();
    }

    /* ---------- phone remote: nothing can connect in to the unit, so both sides meet at a relay ---------- */
    const PAGE = 'jaydrama21-ai.github.io/CarTV';
    if (!config.code) { config.code = relay.newCode(); saveConfig(); }
    async function runDiag() {
      diagLines = ['Scanning the unit...'];
      try {
        diagLines = await diag.collect({ ffmpeg: FFMPEG, probeCommands: true });
        diagLines.forEach((l) => ctx.log.info('DIAG ' + l));
      } catch (e) { diagLines = ['diag error: ' + e.message]; }
    }
    let phone = null;
    const statusMsg = () => ({
      t: 'status',
      v: blocked() ? 'Parked only - stop the car to watch' : status,
      n: channels.length, idx, name: (current() && current().name) || '',
      audioDevice: config.audioDevice, audioBackend: config.audioBackend,
    });
    const reply = (later) => { if (phone) { phone.send(statusMsg()); if (later) setTimeout(() => phone && phone.send(statusMsg()), later); } };
    function tune(i) {
      if (!channels.length) return;
      idx = ((i % channels.length) + channels.length) % channels.length;
      paused = false;
      if (blocked()) return;
      status = 'Tuning ' + ((current() && current().name) || '') + '...';
      if (ui.isVisible('PLAY')) startPlayer(); else ui.open('PLAY');
    }
    function onPhone(m) {
      log.info('phone: ' + m.t);
      if (m.t === 'hello') return reply();
      if (m.t === 'src') {
        config.source = String(m.v || '').trim(); saveConfig(); idx = 0;
        return loadChannels().then(() => reply());
      }
      if (m.t === 'play') {
        const q = String(m.q || '').trim().toLowerCase();
        let i = idx;
        if (/^\d+$/.test(q)) i = Number(q) - 1;
        else if (q) { const f = channels.findIndex((c) => (c.name || '').toLowerCase().indexOf(q) >= 0); if (f < 0) { status = 'No channel matches "' + q + '"'; return reply(); } i = f; }
        tune(i); return reply(8000);
      }
      if (m.t === 'next') { tune(idx + 1); return reply(8000); }
      if (m.t === 'prev') { tune(idx - 1); return reply(8000); }
      if (m.t === 'stop') { paused = true; stopPlayer(); status = 'Stopped'; return reply(); }
      if (m.t === 'audio') {
        if (m.device !== undefined) config.audioDevice = String(m.device || 'default').trim();
        if (m.backend === 'alsa' || m.backend === 'pulse') config.audioBackend = m.backend;
        saveConfig(); if (player) startPlayer();
        return reply();
      }
      if (m.t === 'diag') return runDiag().then(() => phone.sendText('diag', diagLines.join('\n')));
      if (m.t === 'log') return phone.sendText('log', ring.join('\n'));
    }
    try {
      phone = relay.start({ code: config.code, base: process.env.CARTV_RELAY, log: (m) => log.warn(m), onMessage: onPhone });
    } catch (e) { log.warn('phone remote not started: ' + e.message); }
    const phoneLine = () => {
      const st = phone ? phone.state() : { ok: false, error: 'not started' };
      return 'Phone: ' + PAGE + '   code ' + relay.pretty(config.code) + (st.ok ? '' : '   (offline)');
    };

    /* ---------- menu ---------- */
    function menu() {
      const where = channels.length ? '  (' + (idx + 1) + '/' + channels.length + ': ' + ((current() && current().name) || '') + ')' : '';
      ui.text('MENU_INFO', (blocked() ? 'Parked only - video plays when the car is stopped' : status) + where);
      ui.text('PHONE_INFO', phoneLine());
      const ps = phone ? phone.state() : { ok: false, error: 'not started' };
      ui.text('NET_INFO', ps.ok ? 'Phone remote connected' : 'Phone remote: ' + (ps.error || 'connecting...'));
    }
    ui.onClick('BTN_PLAY', () => { if (!blocked() && channels.length) { paused = false; ui.open('PLAY'); } });
    ui.onClick('BTN_NEXTCH', () => { if (channels.length) { idx = (idx + 1) % channels.length; menu(); } });
    ui.onClick('BTN_DIAG', () => { ui.open('DIAG'); runDiag(); });
    ui.onClick('BTN_DBACK', () => ui.open('MAIN'));

    /* ---------- play-screen buttons ---------- */
    ui.onClick('BTN_BACK', () => ui.open('MAIN'));
    ui.onClick('BTN_PREV', () => { if (channels.length) { idx = (idx - 1 + channels.length) % channels.length; startPlayer(); } });
    ui.onClick('BTN_NEXT', () => { if (channels.length) { idx = (idx + 1) % channels.length; startPlayer(); } });
    ui.onClick('BTN_PAUSE', () => { paused = !paused; if (paused) stopPlayer(); else startPlayer(); });

    /* ---------- run the player only while PLAY is up and the car is parked ---------- */
    let running = false;
    function sync() {
      const go = ui.isVisible('PLAY') && !blocked() && !paused;
      if (go !== running) {
        running = go;
        if (go) startPlayer();
        else {
          stopPlayer();
          if (ui.isVisible('PLAY') && blocked()) { log.info('car moving: video stopped'); ui.open('MAIN'); }
        }
      }
      if (ui.isVisible('MAIN')) menu();
    }
    setInterval(sync, 500);
    process.on('exit', () => stopPlayer());

    /* ---------- drawing: latest frame on the whole screen, or a status line ---------- */
    let sr = null;
    function render() {
      const cv = ctx.canvas(1600, 520).clear('#000000');
      const pl = cv.place;
      const msg = !hasFrame ? (blocked() ? 'Parked only' : status) : null;
      if (pl && pl.full) {
        if (!sr || sr.w !== pl.w || sr.h !== pl.h) sr = new Recorder(pl.w, pl.h);
        sr.reset();
        sr.fillRect(0, 0, pl.w, pl.h, '#000000');
        if (hasFrame) {
          const s = Math.min(pl.w / vw, pl.h / vh);
          const w = Math.round(vw * s), h = Math.round(vh * s);
          sr.image(VID, Math.round((pl.w - w) / 2), Math.round((pl.h - h) / 2), w, h);
        }
        if (msg) sr.text(msg.slice(0, 90), pl.w / 2, pl.h / 2, 44, '#ffffff', { align: 'center', font: 'bold' });
        cv.xf(1, 0, 0).append(sr).xf();
      } else {
        if (hasFrame) {
          const s = Math.min(1600 / vw, 520 / vh);
          const w = Math.round(vw * s), h = Math.round(vh * s);
          cv.image(VID, Math.round((1600 - w) / 2), Math.round((520 - h) / 2), w, h);
        }
        if (msg) cv.text(msg, 800, 260, 28, '#ffffff', { align: 'center', font: 'bold' });
      }
      return ui.image('PLAY_GFX', cv);
    }
    ctx.loop('PLAY', 25, render);

    /* ---------- diagnostics screen: the scan as text (also on the phone page) ---------- */
    function renderDiag() {
      const cv = ctx.canvas(1600, 520).clear('#101418');
      const lines = [];
      for (const l of diagLines) for (const part of String(l).split('\n')) lines.push(part);
      cv.text(phoneLine(), 24, 34, 24, '#f4a63c', { font: 'bold' });
      let y = 66, x = 24;
      for (const ln of lines) {
        if (y > 510) { if (x > 24) break; x = 820; y = 66; }
        cv.text(ln.slice(0, 70), x, y, 18, '#e8eaed');
        y += 23;
      }
      return ui.image('DIAG_GFX', cv);
    }
    ctx.loop('DIAG', 2, renderDiag);

    await loadChannels();
    settings.onChange((k) => { if ((k === 'surface' || k === 'maxHeight' || k === 'audio') && running) startPlayer(); });
    log.info('cartv started; ffmpeg ' + FFMPEG + '; ' + phoneLine());
  },
});
