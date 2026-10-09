'use strict';
/*
 * Web DJ köprüsü (sıfır bağımlılık):
 *   tarayıcı --WebSocket(webm/ogg opus)--> köprü --ffmpeg(MP3)--> SHOUTcast v1/v2 (port+1, ICY) veya Icecast
 *
 * Ortam değişkenleri:
 *   PORT=8090  RELAY_SECRET=...(sitedeki "Köprü ortak anahtarı")  ALLOWED_ORIGIN=https://site.com[,https://www.site.com]
 *   FFMPEG_PATH=ffmpeg (yoksa "ffmpeg-static" paketi denenir)  ALLOW_PRIVATE=1 (yalnızca yerel testte; özel IP'lere bağlanmaya izin verir)
 */
const http = require('http'), net = require('net'), crypto = require('crypto'), dns = require('dns').promises, { spawn } = require('child_process');
const { inspectToken, openToken } = require('./token');

const PORT = parseInt(process.env.PORT || '8090', 10);
const SECRET = process.env.RELAY_SECRET || '';
const ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
let FFMPEG = process.env.FFMPEG_PATH || '';
if (!FFMPEG) { try { FFMPEG = require('ffmpeg-static') || 'ffmpeg'; } catch (e) { FFMPEG = 'ffmpeg'; } }
const MAX_CONN = 6, MAX_PAYLOAD = 2 * 1024 * 1024;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let live = null;          // aynı anda tek canlı yayın
const usedNonces = new Map();

/* ---------- minimal WebSocket sunucusu (RFC 6455) ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class WS {
  constructor(socket) {
    this.s = socket; this.buf = Buffer.alloc(0); this.frag = []; this.fragOp = 0; this.open = true; this.h = {};
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.end()); socket.on('error', () => this.end());
  }
  on(ev, fn) { this.h[ev] = fn; return this; }
  end() { if (!this.open) return; this.open = false; try { this.s.destroy(); } catch (e) {} if (this.h.close) this.h.close(); }
  frame(op, payload) {
    const len = payload.length; let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    return Buffer.concat([head, payload]);
  }
  send(obj) { if (this.open) try { this.s.write(this.frame(0x1, Buffer.from(JSON.stringify(obj)))); } catch (e) {} }
  close(code, reason) {
    if (!this.open) return;
    const r = Buffer.from(reason || ''); const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code || 1000, 0); r.copy(p, 2);
    try { this.s.write(this.frame(0x8, p)); } catch (e) {}
    setTimeout(() => this.end(), 200);
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2)) return this.close(1009, 'big'); len = b.readUInt32BE(6); off = 10; }
      if (len > MAX_PAYLOAD) return this.close(1009, 'big');
      if (!masked) return this.close(1002, 'mask');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4); const p = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) p[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { try { this.s.write(this.frame(0xA, p)); } catch (e) {} continue; }
      if (op === 0xA) continue;
      if (op !== 0x0) { this.frag = []; this.fragOp = op; }
      this.frag.push(p);
      if (fin) {
        const data = Buffer.concat(this.frag); const text = this.fragOp === 0x1; this.frag = [];
        if (this.h.message) this.h.message(text ? data.toString('utf8') : data, text);
      }
    }
  }
}

/* ---------- yardımcılar ---------- */
function isPrivateIp(ip) {
  if (ip.includes(':')) { const l = ip.toLowerCase(); return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.'); }
  const p = ip.split('.').map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
async function resolveTarget(t) {
  const port = parseInt(t.port, 10);
  if (!t.host || !/^[A-Za-z0-9.\-]+$/.test(t.host)) throw new Error('Sunucu adresi geçersiz.');
  if (!(port >= 1024 && port <= 65535) && port !== 80) throw new Error('Port geçersiz (1024-65535).');
  const addrs = await dns.lookup(t.host, { all: true, family: 4 });
  if (!addrs.length) throw new Error('Sunucu adresi çözülemedi.');
  if (!ALLOW_PRIVATE && addrs.some(a => isPrivateIp(a.address))) throw new Error('Yerel/özel ağ adreslerine bağlanılamaz.');
  return addrs[0].address;
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').slice(0, n || 120);
function httpGet(ip, port, path, headers, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: ip, port, path, headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (WebDJ Relay)', Connection: 'close' }, headers || {}), timeout: timeout || 4000 }, res => {
      let d = ''; res.on('data', c => { if (d.length < 65536) d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(new Error('zaman aşımı')); }); req.on('error', reject);
  });
}

/* ---------- SHOUTcast kaynak (ICY) el sıkışması ---------- */
function shoutHandshake(ip, t) {
  return new Promise((resolve, reject) => {
    const srcPort = t.source_port ? parseInt(t.source_port, 10) : parseInt(t.port, 10) + 1;
    const sock = net.connect({ host: ip, port: srcPort });
    let done = false, buf = '';
    const fail = m => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} reject(new Error(m)); };
    sock.setNoDelay(true); sock.setTimeout(10000, () => fail('Sunucu yanıt vermedi (zaman aşımı). Port: ' + srcPort));
    sock.on('error', e => fail(e.code === 'ECONNREFUSED' ? 'Bağlantı reddedildi. Kaynak portu ' + srcPort + ' kapalı olabilir.' : 'Bağlantı hatası: ' + e.message));
    sock.on('connect', () => {
      const sid = parseInt(t.sid, 10) || 1;
      sock.write(String(t.password) + (sid > 1 ? ':#' + sid : '') + '\r\n');
    });
    sock.on('data', d => {
      if (done) return;
      buf += d.toString('latin1');
      if (/invalid password|bad password|invalid/i.test(buf)) return fail('Şifre kabul edilmedi (Invalid password).');
      if (/^OK/i.test(buf) && buf.indexOf('\r\n\r\n') >= 0) { done = true; sock.setTimeout(0); resolve({ sock, srcPort }); return; }
      if (buf.length > 400 || (buf.indexOf('\r\n') >= 0 && !/^OK/i.test(buf))) fail('Sunucu beklenmeyen yanıt verdi: ' + clean(buf, 80));
    });
    sock.on('close', () => fail('Sunucu bağlantıyı kapattı (aynı akışta başka bir kaynak bağlı olabilir; Sonic Panel\'de AutoDJ\'yi durdurun).'));
  });
}

/* ---------- oturum ---------- */
function session(ws, tok) {
  const t = tok; let started = false, closed = false, ff = null, sock = null, stage = 'idle', ip = null;
  let bytesIn = 0, bytesOut = 0, t0 = 0, retries = 0, statsTimer = null, retryTimer = null, opts = {}, pending = [];
  const status = (state, extra) => ws.send(Object.assign({ type: 'status', state }, extra || {}));
  const error = (m, fatal) => { ws.send({ type: 'error', message: m, fatal: !!fatal }); };
  const killAll = () => {
    closed = true; clearInterval(statsTimer); clearTimeout(retryTimer);
    try { if (sock) sock.destroy(); } catch (e) {} sock = null;
    if (ff) { try { ff.stdin.end(); } catch (e) {} const f = ff; ff = null; setTimeout(() => { try { f.kill('SIGTERM'); } catch (e) {} }, 800); }
    if (live === handle) live = null;
  };
  const handle = { kill: killAll };

  async function connectDest() {
    if (closed) return;
    stage = 'connecting'; status(retries ? 'reconnecting' : 'connecting', { retry: retries });
    try {
      const r = await shoutHandshake(ip, t);
      if (closed) { r.sock.destroy(); return; }
      sock = r.sock;
      const br = opts.bitrate;
      sock.write(['icy-name:' + clean(t.name || 'Radyo', 100), 'icy-genre:' + clean(t.genre || 'Various', 60), 'icy-url:' + clean(t.url || 'http://localhost', 120),
        'icy-irc:N/A', 'icy-icq:0', 'icy-aim:N/A', 'icy-pub:0', 'icy-br:' + br, 'content-type:audio/mpeg'].join('\r\n') + '\r\n\r\n');
      sock.setTimeout(0); stage = 'live'; retries = 0;
      status('live', { server: t.host + ':' + r.srcPort });
      sock.on('data', () => {});
      sock.on('error', () => {});
      sock.on('close', () => { if (closed) return; sock = null; stage = 'connecting'; scheduleRetry('Sunucu bağlantısı koptu.'); });
    } catch (e) { sock = null; scheduleRetry(e.message); }
  }
  function scheduleRetry(msg) {
    if (closed) return;
    if (/Şifre kabul edilmedi/.test(msg) || retries >= 6) { error(msg + (retries >= 6 ? ' Yeniden bağlanma vazgeçildi.' : ''), true); ws.close(1011, 'dest'); return; }
    retries++; error(msg + ' Yeniden denenecek (' + retries + '/6).', false);
    retryTimer = setTimeout(connectDest, Math.min(1000 * retries * 2, 10000));
  }

  async function pollStats() {
    try {
      let info = { type: 'stats', bytes: bytesOut, uptime: Math.round((Date.now() - t0) / 1000) };
      if (t.protocol !== 'icecast') {
        const r = await httpGet(ip, parseInt(t.port, 10), '/stats?sid=' + (parseInt(t.sid, 10) || 1) + '&json=1', null, 3000);
        const j = JSON.parse(r.body);
        info.listeners = j.currentlisteners; info.peak = j.peaklisteners; info.song = j.songtitle; info.serverStatus = j.streamstatus;
      }
      ws.send(info);
    } catch (e) { ws.send({ type: 'stats', bytes: bytesOut, uptime: Math.round((Date.now() - t0) / 1000) }); }
  }

  async function updateMeta(song) {
    song = clean(song, 200); if (!song) return;
    try {
      let r;
      if (t.protocol === 'icecast') {
        r = await httpGet(ip, parseInt(t.port, 10), '/admin/metadata?mode=updinfo&mount=' + encodeURIComponent(t.mount || '/live') + '&song=' + encodeURIComponent(song),
          { Authorization: 'Basic ' + Buffer.from((t.user || 'source') + ':' + t.password).toString('base64') });
      } else {
        r = await httpGet(ip, parseInt(t.port, 10), '/admin.cgi?sid=' + (parseInt(t.sid, 10) || 1) + '&mode=updinfo&song=' + encodeURIComponent(song) + '&pass=' + encodeURIComponent(t.password));
      }
      ws.send({ type: 'meta', ok: r.status < 400, song, http: r.status });
    } catch (e) { ws.send({ type: 'meta', ok: false, song, message: e.message }); }
  }

  async function start(o) {
    started = true; opts = o;
    const bitrate = [32, 48, 64, 96, 128, 160, 192, 256, 320].includes(+o.bitrate) ? +o.bitrate : 128;
    opts.bitrate = bitrate;
    try { ip = await resolveTarget(t); } catch (e) { error(e.message, true); return ws.close(1008, 'target'); }

    if (o.mode === 'test') {
      try {
        if (t.protocol === 'icecast') {
          const r = await httpGet(ip, parseInt(t.port, 10), '/', null, 4000);
          ws.send({ type: 'test', ok: true, message: 'Icecast sunucusuna ulaşıldı (HTTP ' + r.status + '). Şifre yalnızca yayın başlayınca doğrulanır.' });
        } else {
          const r = await shoutHandshake(ip, t); r.sock.destroy();
          ws.send({ type: 'test', ok: true, message: 'Başarılı: sunucu şifreyi kabul etti (kaynak portu ' + r.srcPort + ').' });
        }
      } catch (e) { ws.send({ type: 'test', ok: false, message: e.message }); }
      return ws.close(1000, 'test');
    }

    if (live) { error('Köprüde zaten başka bir yayın sürüyor.', true); return ws.close(1013, 'busy'); }
    live = handle; t0 = Date.now();
    const args = ['-hide_banner', '-loglevel', 'error', '-probesize', '65536', '-analyzeduration', '500000', '-i', 'pipe:0', '-vn', '-map', '0:a:0',
      '-c:a', 'libmp3lame', '-b:a', bitrate + 'k', '-ar', '44100', '-ac', o.stereo === false ? '1' : '2', '-write_xing', '0'];
    if (t.protocol === 'icecast') {
      const url = 'icecast://' + encodeURIComponent(t.user || 'source') + ':' + encodeURIComponent(t.password) + '@' + ip + ':' + parseInt(t.port, 10) + (t.mount || '/live');
      args.push('-content_type', 'audio/mpeg', '-f', 'mp3', url);
    } else args.push('-f', 'mp3', 'pipe:1');
    ff = spawn(FFMPEG, args, { stdio: ['pipe', t.protocol === 'icecast' ? 'ignore' : 'pipe', 'pipe'] });
    ff.on('error', e => { error('ffmpeg başlatılamadı: ' + e.message, true); ws.close(1011, 'ffmpeg'); });
    ff.stdin.on('error', () => {});
    pending.forEach(b => { if (ff && ff.stdin.writable) ff.stdin.write(b); }); pending = [];
    ff.stderr.on('data', d => { const m = clean(d.toString(), 160); if (m) log('ffmpeg:', m); });
    ff.on('exit', c => { if (!closed) { error('Ses dönüştürücü (ffmpeg) durdu, kod ' + c + '.', true); ws.close(1011, 'ffmpeg'); } });
    if (t.protocol === 'icecast') { stage = 'live'; status('live', { server: t.host + ':' + t.port }); }
    else {
      ff.stdout.on('data', d => { if (stage === 'live' && sock && !sock.destroyed && sock.writableLength < (1 << 20)) { sock.write(d); bytesOut += d.length; } });
      connectDest();
    }
    statsTimer = setInterval(pollStats, 5000);
    log('yayın başladı: dj=' + t.dj + ' ' + t.protocol + ' ' + t.host + ':' + t.port);
  }

  ws.on('message', (data, isText) => {
    if (!isText) {
      bytesIn += data.length;
      if (ff && ff.stdin.writable) ff.stdin.write(data);
      else if (started && !closed && pending.length < 200) pending.push(data);   // ffmpeg başlayana kadar tamponla
      return;
    }
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (m.type === 'start' && !started) start(m);
    else if (m.type === 'meta' && started) updateMeta(m.song);
    else if (m.type === 'stop') ws.close(1000, 'bye');
  });
  ws.on('close', () => { killAll(); if (started) log('yayın bitti: dj=' + t.dj + ' giriş=' + bytesIn + ' çıkış=' + bytesOut); });
  setTimeout(() => { if (!started) ws.close(1008, 'start bekleniyor'); }, 20000);
  ws.send({ type: 'ready' });
}

/* ---------- HTTP + yükseltme ---------- */
let conns = 0;
let lastEvent = null, upgradeCount = 0;
function ev(msg) { lastEvent = { zaman: new Date().toISOString(), olay: msg }; console.log(msg); }
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url && req.url.indexOf('/son') === 0) {   // tarayıcıdan: /son  -> son bağlantı denemesinin sonucu
    return res.end(JSON.stringify({ ok: true, ws_deneme_sayisi: upgradeCount, son_olay: lastEvent, izinli_originler: ORIGINS, anahtar_uzunlugu: SECRET.length }));
  }
  res.end(JSON.stringify({ ok: true, name: 'webdj-relay', live: !!live }));
});
server.on('upgrade', (req, socket) => {
  upgradeCount++;
  const deny = (code, msg) => { try { socket.write('HTTP/1.1 ' + code + ' ' + msg + '\r\nConnection: close\r\n\r\n'); } catch (e) {} socket.destroy(); };
  const origin = req.headers.origin || '';
  if (ORIGINS.length && !ORIGINS.includes(origin)) { ev('[RED] Origin izinli degil. Gelen: "' + origin + '"  Izinli: ' + JSON.stringify(ORIGINS)); return deny(403, 'Forbidden'); }
  if (conns >= MAX_CONN) return deny(503, 'Busy');
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return deny(400, 'Bad Request');
  let token = ''; try { token = new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch (e) {}
  const tok = openToken(token, SECRET);
  if (!tok) { ev('[RED] Token: ' + inspectToken(token, SECRET) + ' | anahtar uzunlugu(Render)=' + SECRET.length + ' | origin=' + origin); return deny(401, 'Unauthorized'); }
  if (tok.n) {
    const now = Date.now(); usedNonces.forEach((v, k) => { if (v < now) usedNonces.delete(k); });
    if (usedNonces.has(tok.n)) return deny(401, 'Unauthorized');
    usedNonces.set(tok.n, now + 300000);
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  ev('[OK] WebSocket baglandi, origin=' + origin);
  socket.setNoDelay(true);
  conns++;
  const ws = new WS(socket);
  const prevClose = () => { conns--; };
  const origEnd = ws.end.bind(ws); let counted = true;
  ws.end = function () { if (counted) { counted = false; prevClose(); } origEnd(); };
  session(ws, tok);
});

if (require.main === module) {
  if (!SECRET) { console.error('RELAY_SECRET gerekli.'); process.exit(1); }
  console.log('[BASLADI] RELAY_SECRET uzunlugu=' + SECRET.length + '  ALLOWED_ORIGIN=' + JSON.stringify(ORIGINS));
  server.listen(PORT, () => log('Web DJ köprüsü dinliyor: ' + PORT + ' (ffmpeg: ' + FFMPEG + ')'));
}
module.exports = { server, isPrivateIp };
