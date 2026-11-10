'use strict';
/*
 * player.js - decode any stream to raw frames and hand them to a sink.
 *
 * Spawns ffmpeg to pull the source (HLS/m3u8, http(s), file, or a URL resolved
 * by sources.js), scale/letterbox to width x height, convert to the requested
 * pixel format, and emit whole frames via onFrame(buf) (and a 'frame' event).
 *
 *   pixfmt 'rgba'    -> width*height*4 bytes  (center-screen kit path: setImage,
 *                       exactly how the Doom app draws full-screen frames)
 *   pixfmt 'yuv420p' -> width*(height + height/2) bytes (renderer video layer)
 *
 * Audio is split off here (-an); routing it to the car is a separate module.
 * Frames are whole and newest-wins at the sink: a late frame is simply replaced.
 *
 * Events: 'start', 'frame'(n, buf), 'stall', 'end', 'error'(e), 'exit'(code,err).
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');

function bytesPerFrame(pixfmt, w, h) {
  if (pixfmt === 'rgba') return w * h * 4;
  if (pixfmt === 'yuv420p') return w * (h + (h >> 1));
  throw new Error('player: unsupported pixfmt ' + pixfmt);
}

class Player extends EventEmitter {
  /**
   * @param {object} opts { ffmpeg='ffmpeg', input, inputArgs=[], width, height,
   *                         fps=25, pixfmt='rgba', fit='fit', stallMs=5000,
   *                         loop=false, hwaccel=null, onFrame }
   */
  constructor(opts) {
    super();
    this.o = Object.assign({ ffmpeg: 'ffmpeg', inputArgs: [], fps: 25, pixfmt: 'rgba', fit: 'fit', stallMs: 5000, loop: false }, opts);
    if (!this.o.input) throw new Error('player: input is required');
    if (!this.o.width || !this.o.height) throw new Error('player: width and height are required');
    this.frameBytes = bytesPerFrame(this.o.pixfmt, this.o.width, this.o.height);
    this.proc = null;
    this.ring = null;
    this.fill = 0;
    this.frames = 0;
    this._stopped = false;
  }

  _vf() {
    const { width: w, height: h, fit, fps } = this.o;
    const scale = fit === 'full'
      ? `scale=${w}:${h}`                                            // fill, may stretch
      : `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +    // fit, keep aspect
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;            // letterbox
    return `${scale},fps=${fps}`;
  }

  _args() {
    const a = ['-hide_banner', '-loglevel', 'error'];
    if (this.o.hwaccel) a.push('-hwaccel', this.o.hwaccel);
    if (/^https?:\/\//i.test(this.o.input)) {
      a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2');
    }
    // -re: read at the stream's own speed, so a file or an on-demand video plays in real time
    a.push('-re', ...this.o.inputArgs, '-i', this.o.input);
    // video output: raw frames to stdout
    a.push('-map', '0:v:0', '-vf', this._vf(), '-pix_fmt', this.o.pixfmt, '-f', 'rawvideo', '-');
    // optional audio output straight to the car's audio device, in the SAME ffmpeg process, so one
    // network fetch feeds both and picture/sound stay in sync. Device + backend come from recon.
    if (this.o.audioDevice) {
      a.push('-map', '0:a:0?');
      if (this.o.audioBackend === 'pulse') a.push('-f', 'pulse', this.o.audioDevice);
      else a.push('-f', 'alsa', this.o.audioDevice);
    }
    return a;
  }

  start() {
    this._stopped = false;
    this.proc = spawn(this.o.ffmpeg, this._args(), { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, this.o.env || {}) });
    this._armStall();
    this.emit('start');

    this.proc.stdout.on('data', (buf) => this._onData(buf));
    let errTail = '';
    this.proc.stderr.on('data', (b) => { errTail = (errTail + b.toString()).slice(-2000); });
    this.proc.on('error', (e) => this.emit('error', e));
    this.proc.on('exit', (code) => {
      clearTimeout(this._stallT);
      this.emit('exit', code, errTail.trim());
      if (this._stopped) return;
      if (this.o.loop) { this.fill = 0; return this.start(); }
      this.emit('end');
    });
    return this;
  }

  // Frames are copied into two buffers that take turns, so nothing is allocated per frame: at this
  // size a fresh buffer for every frame outruns the unit's old Node garbage collector and the app is
  // killed for its memory. The sink keeps the buffer it was given until it gets the next one.
  _onData(buf) {
    if (!this.ring) { this.ring = [Buffer.allocUnsafe(this.frameBytes), Buffer.allocUnsafe(this.frameBytes)]; this.cur = 0; this.fill = 0; }
    let off = 0;
    while (off < buf.length) {
      const n = Math.min(buf.length - off, this.frameBytes - this.fill);
      buf.copy(this.ring[this.cur], this.fill, off, off + n);
      this.fill += n; off += n;
      if (this.fill === this.frameBytes) {
        const frame = this.ring[this.cur];
        this.cur ^= 1; this.fill = 0;
        this.frames++;
        this._armStall();
        if (this.o.onFrame) { try { this.o.onFrame(frame); } catch (e) { this.emit('error', e); } }
        this.emit('frame', this.frames, frame);
        if (this.frames % 50 === 0 && typeof global.gc === 'function') { try { global.gc(); } catch (e) { /* ignore */ } }
      }
    }
  }

  _armStall() {
    clearTimeout(this._stallT);
    this._stallT = setTimeout(() => this.emit('stall'), this.o.stallMs);
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._stallT);
    if (this.proc) { try { this.proc.kill('SIGKILL'); } catch (_) {} this.proc = null; }
    this.fill = 0;
  }
}

module.exports = { Player, bytesPerFrame };
