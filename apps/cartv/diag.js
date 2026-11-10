'use strict';
/*
 * diag.js - on-unit recon, no laptop/SSH needed.
 *
 * Gathers the audio / device / network facts we need to finish audio, by reading
 * /proc and /dev (world-readable, no special perms) and a couple of safe probes.
 * Returns an array of "label: value" lines to draw on screen and write to the log,
 * so the user can just photograph the Diagnostics page.
 */

const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

function tryRead(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return null; } }
function tryList(p) { try { return fs.readdirSync(p); } catch (e) { return null; } }
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }

// scan /proc for running process names we care about
function procs(names) {
  const hit = {};
  const pids = tryList('/proc') || [];
  for (const d of pids) {
    if (!/^\d+$/.test(d)) continue;
    const comm = tryRead('/proc/' + d + '/comm');
    if (!comm) continue;
    for (const n of names) if (comm.toLowerCase().includes(n)) hit[n] = (hit[n] || comm);
  }
  return names.map((n) => n + '=' + (hit[n] ? 'yes (' + hit[n] + ')' : 'no'));
}

// run a short command, capture output, never throw
function run(cmd, args, ms) {
  return new Promise((res) => {
    let done = false;
    const p = execFile(cmd, args, { timeout: ms || 4000, maxBuffer: 1 << 20 }, (err, out, serr) => {
      if (done) return; done = true;
      res((out || serr || (err ? String(err.message) : '')).trim() || '(no output)');
    });
    p.on('error', (e) => { if (!done) { done = true; res('(not available: ' + e.code + ')'); } });
  });
}

async function collect(opts = {}) {
  const L = [];
  const add = (k, v) => L.push(k + ': ' + (v == null ? '(none)' : v));

  // --- system ---
  add('arch', os.arch());
  add('kernel', os.release());
  add('cpus', os.cpus().length);
  add('ffmpeg(bundled)', opts.ffmpeg && exists(opts.ffmpeg) ? opts.ffmpeg : 'MISSING');

  // --- audio: the point of this page ---
  const cards = tryRead('/proc/asound/cards');
  add('asound/cards', cards ? '\n' + cards : '(no /proc/asound - no ALSA?)');
  const pcm = tryRead('/proc/asound/pcm');
  add('asound/pcm', pcm || '(none)');
  const snd = tryList('/dev/snd');
  add('/dev/snd', snd ? snd.join(' ') : '(none)');
  add('audio procs', procs(['pulseaudio', 'mediaengine', 'mediaapp', 'audio']).join('  '));
  add('pulse socket', exists('/run/pulse/native') || exists(os.homedir() + '/.config/pulse') ? 'present' : 'none seen');

  // --- gpu / render (hw decode + which socket) ---
  add('/dev/dri', (tryList('/dev/dri') || []).join(' ') || '(none)');
  add('render socks', ['/run/mgu-renderd/renderd.sock', '/run/mgu-render/render.sock', '/dev/shm/cluster-render/render.sock'].filter(exists).join(' ') || '(none)');

  // --- network / uplink (phone data) ---
  add('ifaces', (tryList('/sys/class/net') || []).join(' ') || '(none)');
  add('wlan0', exists('/sys/class/net/wlan0') ? (tryRead('/sys/class/net/wlan0/operstate') || 'present') : 'absent');
  add('default route', (tryRead('/proc/net/route') || '').split('\n').slice(1).some((r) => r.split(/\s+/)[1] === '00000000') ? 'yes' : 'none');
  add('connman', procs(['connman']).join(''));

  // --- internet for this app: the uplink's lease, names through its dns, the relay ---
  const netx = require('./netx');
  const l = netx.lease();
  add('uplink lease', l ? (l.interface + ' ' + l.ip + ' dns ' + (l.dns || []).join(',')) : 'NONE (car offline, or this app is not allowed out)');
  add('resolve github.com', await netx.resolve('github.com').catch((e) => 'FAILED ' + e.message));
  add('https relay', await netx.request('GET', 'https://ntfy.sh/v1/health', null, { timeout: 8000 }).then((r) => 'answered ' + r.status).catch((e) => 'FAILED ' + e.message));
  add('addresses', Object.keys(os.networkInterfaces()).map((n) => n + '=' + (os.networkInterfaces()[n] || []).filter((a) => a.family === 'IPv4').map((a) => a.address).join('/')).join('  '));

  // --- a couple of safe command probes (ok if they fail) ---
  if (opts.probeCommands) {
    add('ffmpeg runs', (await run(opts.ffmpeg || 'ffmpeg', ['-hide_banner', '-version'], 5000)).split('\n')[0]);
    add('aplay -l', await run('aplay', ['-l'], 4000));
    add('ffmpeg devices', await run(opts.ffmpeg || 'ffmpeg', ['-hide_banner', '-devices'], 5000));
  }
  return L;
}

module.exports = { collect };
