# Veri sınırı ve ilerideki doluluk senkronizasyonu

Masaüstü uygulaması tek yetkili salon verisi kaynağıdır. SQLite dosyasında cihazlar, oturumlar, ürün/sipariş/ödeme/kasa ve yönetim kayıtları için ayrık tabloların eklenmesi planlanır. Bu ilk sürüm cihaz, oturum ve ayar tablolarını içerir.

Buluta **yalnızca** şu anonim özet gönderilebilir: `totalDevices`, `availableDevices`, `occupiedDevices`, `updatedAt`. Cihaz adı/kimliği, oturum başlangıcı, ücret, müşteri, kullanıcı, ürün, sipariş, ödeme, kasa ve işlem logları gönderilmez.

Neon tarafında tek satırlı özet için örnek şema:

```sql
CREATE TABLE salon_occupancy (
  salon_key text PRIMARY KEY,
  total_devices integer NOT NULL,
  available_devices integer NOT NULL,
  occupied_devices integer NOT NULL,
  updated_at timestamptz NOT NULL
);
```

Her senkronizasyonda yalnızca bu kayıt güncellenir:

```sql
INSERT INTO salon_occupancy (salon_key, total_devices, available_devices, occupied_devices, updated_at)
VALUES ('default', $1, $2, $3, now())
ON CONFLICT (salon_key) DO UPDATE SET
  total_devices = EXCLUDED.total_devices,
  available_devices = EXCLUDED.available_devices,
  occupied_devices = EXCLUDED.occupied_devices,
  updated_at = EXCLUDED.updated_at;
```

Bu bağlantı ilk sürümde kasıtlı olarak etkin değildir. API anahtarları yalnızca masaüstü uygulamasının güvenli yapılandırmasında ve Next.js sunucu tarafında tutulmalıdır; tarayıcıya konulmamalıdır.
