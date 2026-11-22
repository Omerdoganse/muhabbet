# 💬 Muhabbet

Arkadaşlarınla oyun oynarken konuşmak için Discord benzeri masaüstü uygulaması.

## Özellikler
- 🔊 Sesli kanallar (Genel Ses, Oyun Odası 1-2, AFK) – ses doğrudan kişiler arasında akar (WebRTC P2P)
- 💬 Yazılı kanallar (#genel, #oyun, #klipler) – link desteği, okunmamış göstergesi
- 🟢 Konuşan kişinin avatarı yeşil yanar
- 🔇 Mikrofon kapatma / 🙉 sağırlaştırma
- ⌨️ **Global kısayollar** (oyun açıkken bile çalışır): `Ctrl+Shift+M` mikrofon, `Ctrl+Shift+D` sağırlaştır
- 🎚️ Her arkadaş için ayrı ses seviyesi (ses kanalında ismin üzerine gel)
- ⚙️ Mikrofon / hoparlör seçimi, gürültü engelleme, mikrofon seviye göstergesi
- 🔔 Kanala giren/çıkan için bildirim sesi
- 🌐 Uygulaması olmayan arkadaş tarayıcıdan da katılabilir (sunucu adresini açması yeterli)

## Yapı
```
server/   Node.js sunucu (Socket.IO): sohbet + sinyal iletimi, web istemcisini de sunar
client/   Electron masaüstü uygulaması (arayüz: client/app)
```

## Çalıştırma

**1) Sunucuyu başlat** (grupta yalnızca BİR kişi yapar):
```powershell
cd server; npm install; npm start
```

**2) Uygulamayı aç** (herkes):
```powershell
cd client; npm install; npm start
```
İstersen `client/app/config.example.js` dosyasını `config.js` adıyla kopyalayıp
`defaultServer` kısmına sunucu adresini yaz; giriş ekranında hazır gelir.
`config.js` GitHub'a yüklenmez.
Giriş ekranında kullanıcı adını ve sunucu adresini yaz.

**3) .exe oluştur** (arkadaşlara göndermek için, Node gerekmez):
```powershell
cd client; npm run dist
```
`client/dist/Muhabbet 1.0.0.exe` dosyasını arkadaşlarına gönder.

## Arkadaşların internetten nasıl bağlanır?
Sunucu senin bilgisayarında `3000` portunda çalışır. Dışarıdan erişim için şunlardan biri:

1. **Aynı ağdaysanız (LAN):** adres `http://<senin-yerel-IP'n>:3000` (örn. `http://192.168.1.20:3000`).
2. **Tünel (en kolayı):** `cloudflared tunnel --url http://localhost:3000` → verdiği `https://....trycloudflare.com` adresini paylaş.
3. **Port yönlendirme:** modemde 3000 portunu bilgisayarına yönlendir, adres `http://<dış-IP'n>:3000`.
4. **Ücretsiz bulut:** `server` + `client/app` klasörlerini Render / Railway / Fly.io'ya yükle (start komutu `node server/server.js`).

> Not: Ses P2P olduğu için çok katı NAT/kurumsal ağlarda bazı kişiler bağlanamayabilir.
> Bu durumda bir TURN sunucusu eklemek gerekir (`client/app/renderer.js` içindeki `ICE` listesi).
