'use strict';
/*
 * netx.js - the network, the way an app on the head unit has to use it.
 *
 * The unit's own resolver never reaches the internet. An app the uplink lets out gets a lease file
 * (<data folder>/uplink.json, or /run/mgu-uplink/lease.json): { interface, ip, router, dns[] ... },
 * present only while online, and must resolve names through the lease's dns servers itself.
 *
 *   init(dataDir)                      where to look for the lease
 *   lease()                            the lease, or null while offline
 *   resolve(host) -> Promise<ip>       through the lease's dns (falls back to the system resolver)
 *   request(method, url, body, opts)   http(s) to the resolved address, with the right Host / SNI
 *   startProxy() -> Promise<port>      a forward proxy on 127.0.0.1 for ffmpeg, which can only use
 *                                      the system resolver: it sends everything through the proxy,
 *                                      and the proxy resolves names here
 *
 * Written for the unit's old Node (8).
 */

const fs = require('fs');
const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');
const path = require('path');
const urlmod = require('url');

let leaseFiles = ['/run/mgu-uplink/lease.json'];
let servers = '';
const cache = {}; // host -> { ip, until }

function init(dataDir) {
  leaseFiles = [path.join(dataDir, 'uplink.json'), '/run/mgu-uplink/lease.json'];
}

function lease() {
  for (let i = 0; i < leaseFiles.length; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(leaseFiles[i], 'utf8'));
      if (j && j.dns && j.dns.length) return j;
    } catch (e) { /* not there: offline, or not allowed out */ }
  }
  return null;
}

function resolve(host) {
  return new Promise(function (resolve_, reject) {
    if (net.isIP(host)) return resolve_(host);
    const hit = cache[host];
    if (hit && hit.until > Date.now()) return resolve_(hit.ip);
    const viaSystem = function (why) {
      dns.lookup(host, { family: 4 }, function (e, ip) {
        if (e) return reject(new Error(why || ('cannot resolve ' + host + ' (' + e.code + ')')));
        resolve_(ip);
      });
    };
    const l = lease();
    if (!l) return viaSystem('car is offline (no internet lease for this app)');
    const want = l.dns.join(',');
    if (want !== servers) { try { dns.setServers(l.dns); servers = want; } catch (e) { return viaSystem(); } }
    let done = false;
    const timer = setTimeout(function () { if (!done) { done = true; reject(new Error('name lookup timed out for ' + host)); } }, 8000);
    dns.resolve4(host, function (e, ips) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (e || !ips || !ips.length) return reject(new Error('cannot resolve ' + host + ' (' + ((e && e.code) || 'no address') + ')'));
      cache[host] = { ip: ips[0], until: Date.now() + 60000 };
      resolve_(ips[0]);
    });
  });
}

/** request(method, url, body, { timeout, headers, maxBytes, redirects }) -> Promise<{ status, body }> */
function request(method, url, body, opts) {
  opts = opts || {};
  const u = urlmod.parse(url);
  const secure = u.protocol === 'https:';
  return resolve(u.hostname).then(function (ip) {
    return new Promise(function (resolve_, reject) {
      const headers = Object.assign({ Host: u.host }, opts.headers || {});
      if (body) { headers['Content-Type'] = headers['Content-Type'] || 'text/plain'; headers['Content-Length'] = Buffer.byteLength(body); }
      const o = { method: method, host: ip, port: u.port || (secure ? 443 : 80), path: u.path, headers: headers };
      if (secure && !net.isIP(u.hostname)) o.servername = u.hostname;
      const req = (secure ? https : http).request(o, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (opts.redirects === undefined ? 5 : opts.redirects) > 0) {
          res.resume();
          const next = urlmod.resolve(url, res.headers.location);
          return resolve_(request(method, next, body, Object.assign({}, opts, { redirects: (opts.redirects === undefined ? 5 : opts.redirects) - 1 })));
        }
        let out = '';
        const max = opts.maxBytes || 8 * 1024 * 1024;
        res.setEncoding('utf8');
        res.on('data', function (c) { if (out.length < max) out += c; });
        res.on('end', function () { resolve_({ status: res.statusCode, body: out }); });
      });
      req.on('error', reject);
      req.setTimeout(opts.timeout || 15000, function () { req.destroy(new Error('timed out reaching ' + u.hostname)); });
      if (body) req.write(body);
      req.end();
    });
  });
}

/** A forward proxy on loopback: CONNECT for https, absolute-URL requests for http. */
function startProxy(log) {
  return new Promise(function (resolve_, reject) {
    const say = log || function () {};
    const server = http.createServer(function (req, res) {
      const u = urlmod.parse(req.url);
      if (!u.hostname) { res.writeHead(400); return res.end(); }
      resolve(u.hostname).then(function (ip) {
        const headers = Object.assign({}, req.headers);
        delete headers['proxy-connection'];
        const up = http.request({ method: req.method, host: ip, port: u.port || 80, path: u.path, headers: headers }, function (r) {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        });
        up.on('error', function (e) { say('proxy: ' + u.hostname + ': ' + e.message); try { res.writeHead(502); } catch (x) { /* sent */ } res.end(); });
        req.pipe(up);
      }).catch(function (e) { say('proxy: ' + e.message); res.writeHead(502); res.end(); });
    });
    server.on('connect', function (req, sock, head) {
      const parts = String(req.url).split(':');
      const host = parts[0], port = Number(parts[1]) || 443;
      sock.on('error', function () {});
      resolve(host).then(function (ip) {
        const up = net.connect(port, ip, function () {
          sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
          if (head && head.length) up.write(head);
          up.pipe(sock); sock.pipe(up);
        });
        up.on('error', function (e) { say('proxy: ' + host + ': ' + e.message); sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
        sock.on('close', function () { up.destroy(); });
      }).catch(function (e) { say('proxy: ' + e.message); sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () { resolve_(server.address().port); });
  });
}

module.exports = { init: init, lease: lease, resolve: resolve, request: request, startProxy: startProxy };
