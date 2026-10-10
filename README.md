# Cave Salon — web tabanlı yönetim

Salon bilgisayarında çalışan yerel veritabanlı web yönetim paneli ve `cave.com.tr` kamu sitesi. Aynı yönetim adresinde geniş ekranlar tam yönetim panelini, telefonlar yalnızca canlı özet ekranını görür.

## Veri mimarisi

- `apps/salon-server`: Salon bilgisayarında çalışan Node.js sunucusu. SQLite uyumlu veritabanı dosyası `apps/salon-server/data/salon.sqlite` içinde kalır.
- `apps/admin-web`: Tarayıcıdaki yönetim arayüzü. Bilgisayarda masa/oturum işlemlerini, mobilde yalnızca doluluk ve kasa özetini gösterir.
- `apps/public-web`: Kamu sitesi; yönetim verisine erişmez.
- `packages/shared`: Ücret ve süre iş kuralları testleri.

Geçmiş oturumlar, kasa verileri ve veritabanı salon bilgisayarında tutulur. Bulut tarafında kalıcı yönetim verisi yoktur.

Veritabanı kaydı önce aynı dizindeki geçici dosyaya yazılır ve bütünlük kontrolünden sonra asıl dosyanın yerini alır. Sunucu açılırken ve saatte bir yapılan kontrolde, son otomatik yedek en az 24 saat önceyse yeni bir yedek oluşturulur. Yedek SQLite bütünlük kontrolünden geçirilir; son 14 otomatik yedek saklanır. Varsayılan konum `apps/salon-server/data/backups` dizinidir. Ayrı bir diske yedek almak için sunucuyu başlatmadan önce `SALON_BACKUP_DIR` ortam değişkenini o dizine ayarlayın. Aynı diskteki yedekler disk arızasına karşı koruma sağlamaz.

## İlk çalıştırma

Bu bilgisayarda PowerShell betik kısıtı varsa `npm` yerine `npm.cmd` kullanın.

```powershell
cd C:\Users\Kaan\Documents\Codex\2026-08-03\files-mentioned-by-the-user-proje
npm.cmd install
npm.cmd run build --workspace=@cave/admin-web
npm.cmd run start:salon
```

Sunucu başlamadan önce `SALON_ADMIN_PASSWORD` tanımlanmalıdır; varsayılan parola artık yoktur. Örnek:

```powershell
$env:SALON_ADMIN_PASSWORD = "uzun-ve-rastgele-bir-sifre"
npm.cmd run start:salon
```

Ardından aynı bilgisayarda `http://127.0.0.1:3001` adresini açın. İlk geliştirme şifresi `cave123`’tür.

> Canlı kullanımdan önce güçlü bir şifre tanımlayın. Örneğin PowerShell’de:
>
> ```powershell
> $env:SALON_ADMIN_PASSWORD = "uzun-ve-rastgele-bir-sifre"
> npm.cmd run start:salon
> ```

Bu ortam değişkeni her yeni terminalde yeniden girilmelidir; kalıcı dağıtımda Windows hizmeti veya güvenli sistem ayarı olarak tanımlayın.

Hatalı girişler varsayılan olarak 15 dakikada 8 denemeden sonra `429` döner. Eşik `SALON_LOGIN_MAX_ATTEMPTS`, pencere `SALON_LOGIN_WINDOW_MS` ile değiştirilir. Sayaç süreç belleğindedir; sunucu yeniden başlayınca sıfırlanır ve birden fazla süreç paylaşmaz. İstemci `X-Forwarded-For` başlığına güvenilmez (`trust proxy` kapalıdır).

Geliştirme sırasında iki terminal kullanın:

```powershell
# Terminal 1 (geliştirme giriş şifresi: cave123)
npm.cmd run dev:server

# Terminal 2
npm.cmd run dev:admin
```

Yönetim ekranı `http://localhost:5173`, API ise `http://127.0.0.1:3001` adresinde olur.

`dev:server` yalnızca geliştirme için geçici `cave123` şifresini kullanır. `start:salon` için `SALON_ADMIN_PASSWORD` tanımlama zorunluluğu devam eder; canlı kullanımdan önce güçlü bir şifre seçin.

## Ekran davranışı

- **768 px ve üzeri:** Masa ekleme, başlatma/durdurma ve saatlik ücret ayarı.
- **768 px altı:** Açık masa sayısı, dolu/boş sayıları, açık oturumların anlık tutarı ve günlük kazanç. İşlem butonları görünmez.

## Uzaktan erişim (VPN olmadan)

Salon bilgisayarında çalışan servisi doğrudan modemden açmayın. `cloudflared` ile `yonetim.cave.com.tr` alan adını yerel `http://127.0.0.1:3001` adresine bağlayın ve Cloudflare Access’te yalnızca izinli e-posta adreslerini OTP ile kabul edin. Bu bağlantı için dışarıdan port açılması gerekmez.

Cloudflare Access, uygulama girişinden önce bir güvenlik katmanıdır; uygulamanın kendi güçlü şifresi de zorunlu kalmalıdır. Salon bilgisayarı açık ve internete bağlı olmalıdır.

## Kontrol

```powershell
npm.cmd run build
npm.cmd test
```

`apps/salon-desktop` önceki Tauri denemesidir; güncel kullanım yolu `apps/admin-web` + `apps/salon-server`dır.
