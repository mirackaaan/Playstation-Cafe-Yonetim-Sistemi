// Local development password for `npm run dev:server` only. Not a start:salon default.
const developmentStarterPassword = "cave123";

export function resolveAdminPassword(env = process.env) {
  const password = env.SALON_ADMIN_PASSWORD;
  if (typeof password !== "string" || !password.trim()) {
    throw new Error("SALON_ADMIN_PASSWORD tanımlanmalıdır; varsayılan parola ile başlatma engellendi.");
  }
  const allowDevelopmentPassword = env.SALON_ALLOW_DEV_PASSWORD === "1";
  const production = env.NODE_ENV === "production";
  if (password === developmentStarterPassword && (production || !allowDevelopmentPassword)) {
    throw new Error("Geliştirme parolası yalnızca npm run dev:server ile kullanılabilir. start:salon için SALON_ADMIN_PASSWORD tanımlayın.");
  }
  return password;
}

export function applyDevelopmentAdminPassword(env = process.env) {
  if (env.NODE_ENV === "production") {
    throw new Error("Geliştirme başlatıcısı üretim ortamında kullanılamaz.");
  }
  env.SALON_ALLOW_DEV_PASSWORD = "1";
  env.SALON_ADMIN_PASSWORD = developmentStarterPassword;
  return env.SALON_ADMIN_PASSWORD;
}
