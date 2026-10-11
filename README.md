# Radyo58 Web DJ Relay (GitHub + Render)

Bu proje, tarayıcıdaki Web DJ'den WebSocket ile gelen **16-bit signed little-endian PCM, mono** sesi MP3'e çevirip SHOUTcast v1 kaynak portuna iletmek için başlangıç köprüsüdür.

> Önemli: Bu servis tek başına mevcut `radyo58.net/dj` sayfasını otomatik olarak uyumlu hâle getirmez. Web DJ JavaScript'i `wss://...onrender.com/ws` adresine bağlanmalı ve ses verisini belirtilen PCM biçiminde ikili (binary) WebSocket mesajlarıyla göndermelidir. Mevcut sayfanız farklı biçimde ses gönderiyorsa o JavaScript tarafı da uyarlanmalıdır.

## 1. GitHub'a yükleme

1. GitHub'da yeni bir repository açın: `radyo58-webdj-relay`.
2. Bu ZIP içindeki dosyaları açıp repository'nin ana dizinine yükleyin: `server.js`, `package.json`, `render.yaml`, `.gitignore`, `README.md`.
3. `RADIO_PASSWORD` veya `RELAY_SECRET` gibi gerçek sırları GitHub dosyalarına yazmayın.

## 2. Render kurulumu

1. Render'da **New + → Web Service** seçin ve GitHub repository'sini bağlayın.
2. Runtime: **Node**; Build Command: `npm install`; Start Command: `npm start`.
3. Render → servis → **Environment** bölümüne aşağıdaki değişkenleri ekleyin.
4. **Save, rebuild, and deploy** ile yeniden dağıtın.

### Render Environment değişkenleri

| Key | Value |
|---|---|
| `ALLOWED_ORIGIN` | `https://radyo58.net` |
| `RADIO_HOST` | `anadolu.liderhost.com.tr` |
| `RADIO_SOURCE_PORT` | `4580` — hosting sağlayıcınızın teyit ettiği kaynak/DJ portu |
| `RADIO_PASSWORD` | SonicPanel'in **kaynak/DJ şifresi**; dinleyici şifresi değil |
| `RELAY_SECRET` | İsterseniz yeni, uzun ve rastgele bir değer; eski/sohbette paylaşılmış anahtarı kullanmayın |
| `STREAM_NAME` | `Radyo58 - Damardan Kalbe` |
| `STREAM_GENRE` | `Arabesk, Türkçe Müzik` |
| `STREAM_URL` | `https://radyo58.net` |
| `INPUT_SAMPLE_RATE` | `44100` |
| `INPUT_CHANNELS` | `1` |
| `MP3_BITRATE` | `128k` |

Render, `PORT` değişkenini kendisi sağlar; elle eklemeniz gerekmez.

## 3. Adresler nasıl ayrılır?

- Site/Web DJ: `https://radyo58.net/dj`
- Render servis ana adresi: Render'ın verdiği `https://....onrender.com`
- Köprü WebSocket adresi: `wss://....onrender.com/ws`
- Radyo dinleme portu: `8144` (dinleyicilerin yayını dinlemesi için)
- Radyo kaynak/DJ portu: `4580` (yalnızca hosting bu portu kaynak bağlantısı olarak doğrularsa)

**8144 veya 4580'i Render URL'sinin sonuna eklemeyin.** Bunlar Render portu değildir. WebSocket yolu bu projede `/ws` olarak tanımlanmıştır.

## 4. Kontrol

Render dağıtımından sonra `https://SIZIN-SERVISINIZ.onrender.com/health` adresini açın. JSON içinde `ok: true` görünmelidir. Bu yalnızca web servisinin çalıştığını doğrular; radyo kaynak bağlantısının veya ses akışının çalıştığını tek başına doğrulamaz.

## 5. Güvenlik ve uyumluluk notları

- Web DJ'de kullanılacak token tarayıcıya gönderilirse kullanıcılar tarafından görülebilir. Bu nedenle `RELAY_SECRET` tarayıcı tarafında tek başına güçlü bir erişim kontrolü sayılmaz; ideal çözüm PHP oturumunuz üzerinden kısa ömürlü bir token üretmektir.
- Kod, SHOUTcast v1'in `password → OK2 → icy headers → MP3` kaynak el sıkışmasını kullanır. LiderHost hesabınız SHOUTcast v2/DJ paneli için farklı bir kaynak protokolü istiyorsa bu kodun o protokole göre değiştirilmesi gerekir. Önce sağlayıcıdan `anadolu.liderhost.com.tr:4580` portunun dış kaynak encoder bağlantısını kabul ettiğini teyit edin.
- Tarayıcı tarafı PCM verisini desteklemiyorsa Web DJ'in mikrofon/ses yakalama kodu ayrıca düzenlenmelidir.
