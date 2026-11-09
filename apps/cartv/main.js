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

const VID = 1;                 // image slot for the latest decoded frame
const DW = 1280, DH = 720;     // decode size (16:9); the canvas scales it to the screen

// the bundled static ffmpeg sits next to this file (build.py copies the asset into javascript/);
// fall back to one on PATH if the bundle is missing.
const BUNDLED_FFMPEG = path.join(__dirname, 'ffmpeg');
const FFMPEG = fs.existsSync(BUNDLED_FFMPEG) ? BUNDLED_FFMPEG : 'ffmpeg';

mgu.run({
  async start(ctx) {
    const { ui, settings, log } = ctx;
    const parked = Parked.watch(ctx, log);
    const blocked = () => settings.get('parkedOnly') !== false && parked.moving();

    let channels = [];
    let idx = 0;
    let player = null;
    let hasFrame = false, vw = DW, vh = DH;
    let status = 'Loading channels...';
    let paused = false;
    let diagLines = ['Press Diagnostics to scan the unit...'];

    const current = () => channels[idx] || null;

    async function loadChannels() {
      const src = (settings.get('playlistUrl') || '').trim();
      try {
        channels = await m3u.load(src);
        status = channels.length ? 'Ready - press Play' : 'Add a playlist or stream URL in Settings';
      } catch (e) {
        channels = []; status = 'Playlist error: ' + e.message; log.warn('playlist: ' + e.message);
      }
      if (idx >= channels.length) idx = 0;
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
      let input = ch.url, inputArgs = [];
      try {
        const r = await sources.resolve(ch.url, { maxHeight: Number(settings.get('maxHeight')) || 720 });
        input = r.input; inputArgs = r.inputArgs || [];
      } catch (e) { status = 'Resolve failed: ' + e.message; log.warn('resolve: ' + e.message); return; }
      const audioOn = settings.get('audio') === 'car';
      player = new Player({
        ffmpeg: FFMPEG,
        input, inputArgs, width: DW, height: DH, fps: 25, pixfmt: 'rgba',
        fit: settings.get('surface') === 'full' ? 'full' : 'fit',
        // audio to the car speakers (experimental): device + backend come from the on-car recon.
        audioDevice: audioOn ? (settings.get('audioDevice') || 'default') : null,
        audioBackend: settings.get('audioBackend') || 'alsa',
        onFrame: (buf) => { setImage(VID, DW, DH, buf); hasFrame = true; vw = DW; vh = DH; },
      });
      player.on('stall', () => { if (!hasFrame) status = 'Buffering...'; log.info('stall'); });
      player.on('error', (e) => { status = 'Error: ' + e.message; log.warn('player: ' + e.message); });
      player.on('exit', (code, err) => { if (code) log.info('ffmpeg exit ' + code + ' ' + (err || '')); });
      player.on('end', () => { if (ui.isVisible('PLAY') && !blocked() && !paused) { log.info('stream ended; retrying'); startPlayer(); } });
      player.start();
    }

    /* ---------- menu ---------- */
    function menu() {
      const where = channels.length ? '  (' + (idx + 1) + '/' + channels.length + ': ' + (current() && current().name || '') + ')' : '';
      ui.text('BTN_PLAY', 'Play');
      ui.text('MENU_INFO', (blocked() ? 'Parked only - video plays when the car is stopped' : status) + where);
    }
    ui.onClick('BTN_PLAY', () => { if (!blocked() && channels.length) ui.open('PLAY'); });
    ui.onClick('BTN_NEXTCH', () => { if (channels.length) { idx = (idx + 1) % channels.length; menu(); } });

    /* ---------- on-unit diagnostics (no laptop/SSH): scan + show on screen ---------- */
    ui.onClick('BTN_DIAG', async () => {
      diagLines = ['Scanning the unit...'];
      ui.open('DIAG');
      try {
        diagLines = await diag.collect({ ffmpeg: FFMPEG, probeCommands: true });
        diagLines.forEach((l) => log.info('DIAG ' + l));
      } catch (e) { diagLines = ['diag error: ' + e.message]; }
    });
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
    setInterval(sync, 300);
    if (ui.onFocus) ui.onFocus(() => sync());
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
        if (msg) sr.text(msg, pl.w / 2, pl.h / 2, 30, '#ffffff', { align: 'center', font: 'bold' });
        cv.xf(1, 0, 0).append(sr).xf();
      } else {
        if (hasFrame) cv.image(VID, 0, 0, 1600, 520);
        if (msg) cv.text(msg, 800, 260, 28, '#ffffff', { align: 'center', font: 'bold' });
      }
      return ui.image('PLAY_GFX', cv);
    }
    ctx.loop('PLAY', 25, render);

    /* ---------- diagnostics screen: draw the scan as text to photograph ---------- */
    let dsr = null;
    function renderDiag() {
      const cv = ctx.canvas(1600, 520).clear('#0a0a0a');
      const pl = cv.place;
      const lines = [];
      for (const l of diagLines) for (const part of String(l).split('\n')) lines.push(part);
      const draw = (api, W, H) => {
        let y = 18;
        api.text('Car TV - Diagnostics (photograph this)', 14, y, 20, '#4fd1c5', { font: 'bold' });
        y += 30;
        for (const ln of lines) {
          if (y > H - 8) break;
          api.text(ln.slice(0, 120), 14, y, 15, '#e5e5e5');
          y += 19;
        }
      };
      if (pl && pl.full) {
        if (!dsr || dsr.w !== pl.w || dsr.h !== pl.h) dsr = new Recorder(pl.w, pl.h);
        dsr.reset();
        dsr.fillRect(0, 0, pl.w, pl.h, '#0a0a0a');
        draw(dsr, pl.w, pl.h);
        cv.xf(1, 0, 0).append(dsr).xf();
      } else {
        draw(cv, 1600, 520);
      }
      return ui.image('DIAG_GFX', cv);
    }
    ctx.loop('DIAG', 2, renderDiag);

    await loadChannels();
    settings.onChange((k) => {
      if (k === 'playlistUrl') loadChannels();
      if ((k === 'surface' || k === 'maxHeight') && running) startPlayer();
    });
    log.info('cartv started');
  },
});
