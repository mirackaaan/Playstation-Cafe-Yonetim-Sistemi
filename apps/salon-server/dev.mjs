if (process.env.NODE_ENV === "production") {
  throw new Error("Geliştirme başlatıcısı üretim ortamında kullanılamaz.");
}

process.env.SALON_ADMIN_PASSWORD = "cave123";

await import("./server.mjs");
