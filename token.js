'use strict';
// PHP relay_token() ile aynı biçim: "v2." + base64url( iv(12) | tag(16) | AES-256-GCM(JSON) )
// Anahtar: sha256(RELAY_SECRET). Bağlantı bilgileri (şifre dahil) şifreli taşınır; URL'de düz metin görünmez.
const crypto = require('crypto');

function keyOf(secret) { return crypto.createHash('sha256').update(String(secret), 'utf8').digest(); }
function b64uToBuf(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function bufToB64u(b) { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function openToken(token, secret, now) {
  if (!secret || typeof token !== 'string' || token.slice(0, 3) !== 'v2.') return null;
  try {
    const raw = b64uToBuf(token.slice(3));
    if (raw.length < 30) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    const data = JSON.parse(json);
    if (!data || typeof data.exp !== 'number' || data.exp < (now || Math.floor(Date.now() / 1000))) return null;
    return data;
  } catch (e) { return null; }
}
// yalnızca testler için (üretimde token'ı PHP üretir)
function sealToken(payload, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return 'v2.' + bufToB64u(Buffer.concat([iv, c.getAuthTag(), enc]));
}
// yalnızca günlük için: neden reddedildi?
function inspectToken(token, secret) {
  if (!secret) return 'RELAY_SECRET bos';
  if (typeof token !== 'string' || token.slice(0, 3) !== 'v2.') return 'token yok/biçim hatalı (adres sonu ?token= alamıyor olabilir)';
  try {
    const raw = b64uToBuf(token.slice(3));
    if (raw.length < 30) return 'token çok kısa';
    const d = crypto.createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    const data = JSON.parse(json);
    if (typeof data.exp !== 'number') return 'token içeriği hatalı';
    const now = Math.floor(Date.now() / 1000);
    if (data.exp < now) return 'token süresi dolmuş (sunucu saatleri farklı olabilir, fark ' + (now - data.exp) + ' sn)';
    return 'tamam';
  } catch (e) { return 'ANAHTAR FARKLI: sitedeki Köprü ortak anahtarı ile Render RELAY_SECRET birebir aynı değil'; }
}
module.exports = { openToken, sealToken, inspectToken };
