'use strict';
/*
 * videolayer.js - thin wrapper over the MGU renderer's native `video` layer.
 *
 * The renderer (mgu-render / cluster-render) exposes a video layer that takes a
 * whole YUV 4:2:0 (yuv420p) frame per update, newest-wins. Contract taken from
 * the render client in the idrive7 cluster apps:
 *
 *   layer = client.video({ target, x, y, w, h, vw, vh, fps })
 *   client.frame(layer, atlas, id)      // atlas.length === vw*(vh + (vh>>1))
 *
 * A yuv420p frame is exactly that many bytes: W*H (Y) + 2*(W/2 * H/2) (U,V)
 *                                            = W*H + W*H/2 = W*(H + H/2).
 *
 * We keep the real render client injectable so the same code runs on the head
 * unit (real client) and under test (a mock that validates the byte contract).
 */

function frameBytes(vw, vh) {
  // integer math, matches the renderer: w * (h + (h >> 1))
  return vw * (vh + (vh >> 1));
}

class VideoLayer {
  /**
   * @param {object} client  render client exposing video(opts)->ref and frame(ref, buf, id)->bool
   * @param {object} opts     { target='panel', x, y, w, h, vw, vh, fps }
   */
  constructor(client, opts) {
    this.client = client;
    this.opts = Object.assign({ target: 'panel', fps: 30 }, opts);
    const o = this.opts;
    if (!o.vw || !o.vh) throw new Error('VideoLayer: vw and vh are required');
    this.bytes = frameBytes(o.vw, o.vh);
    this.id = 0;
    this.ref = client.video({
      target: o.target, x: o.x, y: o.y, w: o.w, h: o.h,
      vw: o.vw, vh: o.vh, fps: o.fps,
    });
    if (!this.ref) throw new Error('VideoLayer: renderer refused the layer (0)');
  }

  /** Push one yuv420p frame. Returns false if the socket wasn't ready (newest-wins drops it). */
  push(atlas) {
    if (atlas.length !== this.bytes) {
      throw new Error(`VideoLayer: frame is ${atlas.length} bytes, expected ${this.bytes} (${this.opts.vw}x${this.opts.vh} yuv420p)`);
    }
    return this.client.frame(this.ref, atlas, ++this.id);
  }

  close() {
    if (this.ref && this.client.drop) this.client.drop(this.ref);
    this.ref = 0;
  }
}

module.exports = { VideoLayer, frameBytes };
