'use strict';

const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const ffmpegPath = require('ffmpeg-static');

const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || 'https://radyo58.net').replace(/\/$/, '');
const RELAY_SECRET = process.env.RELAY_SECRET || '';
const RADIO_HOST = process.env.RADIO_HOST || '';
const RADIO_SOURCE_PORT = Number(process.env.RADIO_SOURCE_PORT || 4580);
const RADIO_PASSWORD = process.env.RADIO_PASSWORD || '';
const STREAM_NAME = process.env.STREAM_NAME || 'Radyo58 - Damardan Kalbe';
const STREAM_GENRE = process.env.STREAM_GENRE || 'Arabesk, Türkçe Müzik';
const STREAM_URL = process.env.STREAM_URL || 'https://radyo58.net';
const SAMPLE_RATE = Number(process.env.INPUT_SAMPLE_RATE || 44100);
const CHANNELS = Number(process.env.INPUT_CHANNELS || 1);
const BITRATE = process.env.MP3_BITRATE || '128k';

let active = null;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'radyo58-webdj-relay', connected: Boolean(active) }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocket.Server({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { socket.destroy(); return; }

  const origin = (req.headers.origin || '').replace(/\/$/, '');
  if (origin && origin !== ALLOWED_ORIGIN) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  // Optional token. Set RELAY_SECRET in Render and send it as ?token=... from the Web DJ client.
  // A token embedded in browser code is visible to site visitors; use only as a basic gate.
  if (RELAY_SECRET && url.searchParams.get('token') !== RELAY_SECRET) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

function sendStatus(ws, type, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, message }));
}

function stopActive(reason = 'Yayın durduruldu') {
  if (!active) return;
  const current = active;
  active = null;
  try { current.ws.close(1000, reason.slice(0, 120)); } catch {}
  try { current.ffmpeg.kill('SIGTERM'); } catch {}
  try { current.radio.destroy(); } catch {}
}

wss.on('connection', ws => {
  if (active) {
    sendStatus(ws, 'error', 'Başka bir Web DJ bağlantısı zaten yayında.');
    ws.close(1013, 'A stream is already active');
    return;
  }
  if (!RADIO_HOST || !RADIO_PASSWORD) {
    sendStatus(ws, 'error', 'Render ortam değişkenlerinde RADIO_HOST ve RADIO_PASSWORD eksik.');
    ws.close(1011, 'Radio settings missing');
    return;
  }

  const radio = net.createConnection({ host: RADIO_HOST, port: RADIO_SOURCE_PORT });
  let ffmpeg;
  let radioReady = false;
  let radioBuffer = Buffer.alloc(0);
  let gotOk2 = false;
  let closed = false;

  const state = { ws, radio, ffmpeg: null };
  active = state;

  const fail = (msg) => {
    if (closed) return;
    closed = true;
    sendStatus(ws, 'error', msg);
    if (active === state) active = null;
    try { if (ffmpeg) ffmpeg.kill('SIGTERM'); } catch {}
    try { radio.destroy(); } catch {}
    try { if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Relay error'); } catch {}
  };

  radio.setTimeout(15000, () => fail('Radyo sunucusuna bağlantı zaman aşımına uğradı. Host/port ve kaynak portunu kontrol edin.'));
  radio.on('connect', () => {
    radio.setTimeout(0);
    // SHOUTcast v1 source handshake: password line, then wait for OK2.
    radio.write(`${RADIO_PASSWORD}\r\n`);
  });

  radio.on('data', chunk => {
    if (radioReady || closed) return;
    radioBuffer = Buffer.concat([radioBuffer, chunk]);
    if (radioBuffer.length > 8192) return fail('Radyo sunucusundan beklenmeyen yanıt alındı.');
    const text = radioBuffer.toString('latin1');
    if (/invalid password|authentication failed|denied/i.test(text)) {
      return fail('Radyo sunucusu kaynak şifresini reddetti. RADIO_PASSWORD değerini kontrol edin.');
    }
    if (text.includes('OK2')) {
      gotOk2 = true;
      radioReady = true;
      // SHOUTcast v1 metadata headers follow the OK2 response.
      radio.write(
        `icy-name:${STREAM_NAME}\r\n` +
        `icy-genre:${STREAM_GENRE}\r\n` +
        `icy-url:${STREAM_URL}\r\n` +
        `icy-pub:1\r\n` +
        `icy-br:${parseInt(BITRATE, 10) || 128}\r\n\r\n`
      );
      ffmpeg = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', 'pipe:0',
        '-vn', '-codec:a', 'libmp3lame', '-b:a', BITRATE, '-f', 'mp3', 'pipe:1'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      state.ffmpeg = ffmpeg;
      ffmpeg.stdout.on('data', data => {
        if (!closed && !radio.destroyed && radio.writable) radio.write(data);
      });
      ffmpeg.stderr.on('data', data => {
        const msg = data.toString().trim();
        if (msg) console.error('[ffmpeg]', msg.slice(0, 500));
      });
      ffmpeg.on('error', err => fail(`FFmpeg başlatılamadı: ${err.message}`));
      ffmpeg.on('close', code => {
        if (!closed && code !== 0) fail(`FFmpeg kapandı (kod ${code}).`);
      });
      sendStatus(ws, 'ready', 'Radyo sunucusuna bağlandı. 16-bit PCM mono ses bekleniyor.');
      return;
    }
    // Some hosting panels return a brief OK response instead of OK2.
    if (/^OK\s*$/m.test(text) && !gotOk2) {
      return fail('Sunucu OK2 yerine farklı bir yanıt verdi. Kaynak portu veya SHOUTcast protokolü hosting tarafından doğrulanmalı.');
    }
  });

  radio.on('error', err => fail(`Radyo sunucusuna bağlanılamadı: ${err.message}`));
  radio.on('close', () => {
    if (!closed) fail('Radyo sunucusu bağlantıyı kapattı.');
  });

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    if (!radioReady || !ffmpeg) {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ping') sendStatus(ws, 'pong', 'ok');
        } catch {}
      }
      return;
    }
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'stop') {
        stopActive('Web DJ durdurdu');
      } else if (msg.type === 'ping') {
        sendStatus(ws, 'pong', 'ok');
      }
      return;
    }
    // Binary messages must contain raw signed 16-bit little-endian PCM audio.
    if (ffmpeg.stdin.writable) ffmpeg.stdin.write(Buffer.from(data));
  });

  ws.on('close', () => {
    if (active === state) stopActive('Web DJ bağlantısı kapandı');
  });
  ws.on('error', err => fail(`WebSocket hatası: ${err.message}`));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Radyo58 relay listening on ${PORT}; WebSocket path: /ws`);
  if (!RADIO_HOST || !RADIO_PASSWORD) console.warn('Set RADIO_HOST and RADIO_PASSWORD in Render Environment.');
});
