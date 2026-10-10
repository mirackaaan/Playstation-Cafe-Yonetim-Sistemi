# Cave Salon

PlayStation kafe için yerel yönetim paneli: masalar, oturumlar, tarife, adisyon, kasa ve raporlar salon bilgisayarındaki SQLite dosyasında tutulur. `cave.com.tr` kamu sitesi bu yönetim verisine bağlanmaz.

Proje henüz canlıya alınmamıştır. Aşağıdaki komutlar geliştirme ve aynı makinede deneme içindir.

**Temel özellikler**

- Masa açma/kapama, süreli paket ve süresiz tarife, kol sayısı, masa aktarımı
- Nakit / kart tahsilat, kısmi ödeme, ücretsiz kapanış, geri alma
- Adisyon, tezgâh satışı, günlük rapor ve özet
- Aynı adreste geniş ekranda tam panel, dar ekranda yalnızca canlı özet

## Depo yapısı

| Klasör | Görev |
| --- | --- |
| `apps/salon-server` | Express API ve SQLite. Varsayılan dosya: `apps/salon-server/data/salon.sqlite` |
| `apps/admin-web` | Yönetim arayüzü (React, Vite). Derlenmiş `dist` dosyasını sunucu statik olarak verir |
| `apps/shared` | Canlı ücret motoru (`pricing.mjs`); sunucu ve yönetim paneli bunu kullanır |
| `packages/shared` | Ayrı ücret örnekleri ve Vitest; salon sunucusu bunu import etmez |
| `apps/public-web` | Next.js kamu sitesi; yönetim API’sine bağlanmaz |
| `apps/salon-desktop` | Eski Tauri denemesi. Güncel yol `admin-web` + `salon-server` |

Bulutta kalıcı kasa, oturum veya müşteri kaydı yoktur. Kamu sitesindeki doluluk kutusu henüz canlı veri göstermez (`docs/data-boundary.md`).

## Gereksinimler

- Node.js 22 veya üzeri (`package.json` → `engines.node`)
- Komutlar **proje kökünde** (`README.md` ile aynı klasör)
- Windows PowerShell `npm` betiğini engellerse `npm.cmd` kullanın

## Normal başlatma

Yerel salon denemesi. Geliştirme parolası bu yolda varsayılan değildir.

```powershell
npm.cmd install
```

```powershell
npm.cmd run build --workspace=@cave/admin-web
```

```powershell
$env:SALON_ADMIN_PASSWORD = "uzun-ve-rastgele-bir-sifre"
```

```powershell
npm.cmd run start:salon
```

`start:salon` `node server.mjs` çalıştırır. `SALON_ADMIN_PASSWORD` yoksa, boşsa veya yalnızca boşluksa süreç başlamaz. Geliştirme parolasını bu komutla vermeyin.

Tarayıcı: `http://127.0.0.1:3001` (sunucu `127.0.0.1`, varsayılan `PORT=3001`). Giriş, az önce verdiğiniz değişkendir. Değişken her yeni terminalde yeniden yazılır.

Hatalı giriş: varsayılan 15 dakikada 8 deneme sonrası `429`. `SALON_LOGIN_MAX_ATTEMPTS` ve `SALON_LOGIN_WINDOW_MS` ile değişir. Sayaç bellek içindedir; yeniden başlatınca sıfırlanır. `trust proxy` kapalıdır; `X-Forwarded-For` kullanılmaz.

## Geliştirme

İki terminal, proje kökü.

Terminal 1:

```powershell
npm.cmd run dev:server
```

Terminal 2:

```powershell
npm.cmd run dev:admin
```

Yerel giriş bilgisi `dev.mjs` / `admin-password.mjs` içindedir; yalnızca `dev:server` ile geçerlidir. `NODE_ENV=production` iken `dev:server` başlamaz. `SALON_ALLOW_DEV_PASSWORD` yalnızca bu başlatıcının koyduğu işarettir; `start:salon` onu açmaz ve geliştirme parolasını kabul etmez.

- Arayüz: `http://localhost:5173` (Vite; `/api` → `http://127.0.0.1:3001`)
- API: `http://127.0.0.1:3001`

Kamu sitesi için ayrı olarak `npm.cmd run dev:web` vardır.

## Ekran

`apps/admin-web` `window.innerWidth <= 768` ile mobil özeti açar.

- **769 px ve üzeri:** masalar, oturum ve kasa işlemleri
- **768 px ve altı:** açık/dolu/boş sayıları, anlık tutar, günlük kazanç; işlem butonları yok

## Veri ve yedek

Yazma: geçici dosya → bütünlük kontrolü (`PRAGMA integrity_check`) → asıl SQLite. Açılışta ve her saat `backupIfDue` çalışır; son otomatik yedek 24 saatten yeniyse yeni yedek alınmaz. Yedek de bütünlük kontrolünden geçer. En fazla 14 otomatik yedek tutulur. Varsayılan dizin: `apps/salon-server/data/backups`. Farklı disk için başlatmadan önce `SALON_BACKUP_DIR`. Aynı disk yedeği disk arızasına karşı koruma değildir.

## Uzaktan erişim

Bu depoda Cloudflare Tunnel yapılandırması yoktur. Canlıda salon sürecini modemden port açarak vermeyin. Önerilen kurulum: `cloudflared` ile bir host adını `http://127.0.0.1:3001` adresine bağlamak ve Cloudflare Access ile izinli e-posta + OTP. Access, uygulama şifresinin yerini tutmaz. Salon bilgisayarı açık ve ağda olmalıdır.

## Kontrol

Proje kökünde:

```powershell
npm.cmd run build
```

```powershell
npm.cmd test
```

`build` workspace derlemelerini çalıştırır (`admin-web`, `public-web`, `salon-desktop`; sunucunun ayrı build betiği yoktur).

## Canlıya geçiş

Henüz yapılmadı.

- Geliştirme başlatıcısındaki parolayı canlıda kullanmayın; güçlü, benzersiz yönetici parolası seçin
- `SALON_ADMIN_PASSWORD` güvenli ortam / Windows hizmeti (kaynağa ve Git’e yazmayın)
- Canlı süreçte `dev:server` kullanmayın
- `start:salon` + sizin parolanız
- `npm.cmd test` ve `npm.cmd run build` yeniden
- Tunnel ve Access ayarlarını ayrı doğrulayın
