'use strict';
/*
 * remote.js - the phone remote: a small web page served by the app on the head unit.
 *
 * The iDrive has no text field an app can use, so the phone (on the same network as the unit,
 * normally the phone's own hotspot) opens http://<unit address>:8099 and there you paste the
 * playlist or stream URL, pick a channel, and read the diagnostics and the log as text.
 * Plain Node http, written for the unit's old Node (no modern syntax).
 */

const http = require('http');
const os = require('os');

const PORT = 8099;

function addresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name: name, address: a.address });
    });
  });
  // the phone reaches the unit over Wi-Fi: list wlan first
  out.sort(function (a, b) { return (/^wl/.test(b.name) ? 1 : 0) - (/^wl/.test(a.name) ? 1 : 0); });
  return out;
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const parts = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(parts).toString('utf8')); });
    req.on('error', reject);
  });
}

const PAGE = '<!doctype html><html><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Car TV</title><style>' +
'body{font:16px -apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#101418;color:#e8eaed}' +
'h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 8px;color:#9aa0a6}' +
'textarea,input,select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border-radius:8px;border:1px solid #3c4043;background:#1b2026;color:#e8eaed}' +
'textarea{height:96px}button{font:inherit;padding:10px 14px;border-radius:8px;border:0;background:#f4a63c;color:#111;font-weight:600;margin:8px 8px 0 0}' +
'button.g{background:#2b3138;color:#e8eaed}#st{color:#f4a63c;margin:4px 0 0}' +
'.ch{display:block;width:100%;text-align:left;background:#1b2026;color:#e8eaed;font-weight:400;margin:6px 0 0}.ch.on{outline:2px solid #f4a63c}' +
'pre{white-space:pre-wrap;word-break:break-word;background:#1b2026;padding:10px;border-radius:8px;font-size:12px;max-height:320px;overflow:auto}' +
'.row{display:flex;gap:8px}.row>*{flex:1}' +
'</style></head><body><h1>Car TV</h1><div id="st">connecting...</div>' +
'<h2>Playlist or stream</h2>' +
'<textarea id="src" placeholder="Paste an m3u / Xtream playlist URL, a stream URL (.m3u8), ytdlp:https://... , or a whole #EXTM3U playlist"></textarea>' +
'<button onclick="save()">Save</button><button class="g" onclick="post(\'/api/stop\')">Stop</button>' +
'<h2>Channels</h2><input id="q" placeholder="Search" oninput="draw()"><div id="chs"></div>' +
'<h2>Sound (experimental)</h2><div class="row"><select id="ab"><option value="alsa">ALSA</option><option value="pulse">PulseAudio</option></select>' +
'<input id="ad" placeholder="device, e.g. default or hw:0,0"></div><button class="g" onclick="saveAudio()">Save sound device</button>' +
'<h2>Diagnostics</h2><button class="g" onclick="post(\'/api/diag\')">Scan the unit</button><button class="g" onclick="copy(\'dg\')">Copy</button><pre id="dg"></pre>' +
'<h2>Log</h2><button class="g" onclick="copy(\'lg\')">Copy</button><pre id="lg"></pre>' +
'<script>' +
'var S=null,typed=false;document.getElementById("src").oninput=function(){typed=true};' +
'function post(u,b){return fetch(u,{method:"POST",body:b||""}).then(load)}' +
'function save(){typed=false;post("/api/source",document.getElementById("src").value)}' +
'function saveAudio(){post("/api/audio",JSON.stringify({backend:document.getElementById("ab").value,device:document.getElementById("ad").value}))}' +
'function copy(id){var t=document.getElementById(id).textContent;if(navigator.clipboard)navigator.clipboard.writeText(t)}' +
'function draw(){if(!S)return;var q=document.getElementById("q").value.toLowerCase(),h="",n=0;' +
'for(var i=0;i<S.channels.length&&n<300;i++){var c=S.channels[i];if(q&&c.toLowerCase().indexOf(q)<0)continue;n++;' +
'h+="<button class=\\"ch"+(i===S.idx?" on":"")+"\\" onclick=\\"post(\'/api/play?i="+i+"\')\\">"+(i+1)+". "+c.replace(/</g,"&lt;")+"</button>"}' +
'document.getElementById("chs").innerHTML=h||"<div>No channels yet</div>"}' +
'function load(){return fetch("/api/state").then(function(r){return r.json()}).then(function(s){S=s;' +
'document.getElementById("st").textContent=s.status+(s.playing?" (playing)":"");' +
'if(!typed&&document.activeElement.id!=="src")document.getElementById("src").value=s.source||"";' +
'if(document.activeElement.id!=="ad"){document.getElementById("ad").value=s.audioDevice||"";document.getElementById("ab").value=s.audioBackend||"alsa"}' +
'document.getElementById("dg").textContent=(s.diag||[]).join("\\n");document.getElementById("lg").textContent=(s.log||[]).join("\\n");draw()})' +
'.catch(function(){document.getElementById("st").textContent="cannot reach the car"})}' +
'load();setInterval(load,3000);' +
'</script></body></html>';

/**
 * start(api): api = { state() -> object, setSource(text), play(i), stop(), diag(), setAudio({backend, device}), log }
 * Returns { port, addresses() }.
 */
function start(api) {
  const server = http.createServer(function (req, res) {
    const url = req.url || '/';
    const path = url.split('?')[0];
    const send = function (code, type, body) {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const ok = function () { send(200, 'application/json', '{"ok":true}'); };
    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) return send(200, 'text/html; charset=utf-8', PAGE);
      if (req.method === 'GET' && path === '/api/state') return send(200, 'application/json', JSON.stringify(api.state()));
      if (req.method !== 'POST') return send(404, 'text/plain', 'not found');
      readBody(req, 4 * 1024 * 1024).then(function (body) {
        if (path === '/api/source') { api.setSource(body); return ok(); }
        if (path === '/api/play') { const m = /[?&]i=(\d+)/.exec(url); api.play(m ? Number(m[1]) : 0); return ok(); }
        if (path === '/api/stop') { api.stop(); return ok(); }
        if (path === '/api/diag') { api.diag(); return ok(); }
        if (path === '/api/audio') { let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) { j = {}; } api.setAudio(j); return ok(); }
        send(404, 'text/plain', 'not found');
      }).catch(function (e) { send(400, 'text/plain', String(e.message)); });
    } catch (e) {
      send(500, 'text/plain', String(e.message));
    }
  });
  server.on('error', function (e) { if (api.log) api.log('phone remote: ' + e.message); });
  server.listen(PORT, '0.0.0.0');
  return { port: PORT, addresses: addresses };
}

module.exports = { start: start, addresses: addresses, PORT: PORT };
