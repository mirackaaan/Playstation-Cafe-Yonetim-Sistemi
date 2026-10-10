import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyDevelopmentAdminPassword, resolveAdminPassword } from "./admin-password.mjs";

test("admin password is required outside the development starter", () => {
  assert.throws(() => resolveAdminPassword({}), /SALON_ADMIN_PASSWORD tanımlanmalıdır/);
  assert.throws(() => resolveAdminPassword({ SALON_ADMIN_PASSWORD: "" }), /SALON_ADMIN_PASSWORD tanımlanmalıdır/);
  assert.throws(() => resolveAdminPassword({ SALON_ADMIN_PASSWORD: "   " }), /SALON_ADMIN_PASSWORD tanımlanmalıdır/);
});

test("development starter password is rejected for normal and production starts", () => {
  assert.throws(
    () => resolveAdminPassword({ SALON_ADMIN_PASSWORD: "cave123" }),
    /Geliştirme parolası yalnızca npm run dev:server/
  );
  assert.throws(
    () => resolveAdminPassword({ SALON_ADMIN_PASSWORD: "cave123", SALON_ALLOW_DEV_PASSWORD: "1", NODE_ENV: "production" }),
    /Geliştirme parolası yalnızca npm run dev:server/
  );
  assert.equal(
    resolveAdminPassword({ SALON_ADMIN_PASSWORD: "cave123", SALON_ALLOW_DEV_PASSWORD: "1" }),
    "cave123"
  );
  assert.equal(resolveAdminPassword({ SALON_ADMIN_PASSWORD: "operator-chosen-password" }), "operator-chosen-password");
});

test("development starter refuses production and opts into the local password", () => {
  assert.throws(() => applyDevelopmentAdminPassword({ NODE_ENV: "production" }), /üretim ortamında kullanılamaz/);
  const env = {};
  assert.equal(applyDevelopmentAdminPassword(env), "cave123");
  assert.equal(env.SALON_ALLOW_DEV_PASSWORD, "1");
  assert.equal(resolveAdminPassword(env), "cave123");
});

test("server.mjs exits when SALON_ADMIN_PASSWORD is missing", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cave-password-policy-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      PORT: String(37000 + Math.floor(Math.random() * 1000)),
      SALON_DB_PATH: path.join(temp, "salon.sqlite"),
      SALON_ADMIN_PASSWORD: "",
      SALON_ALLOW_DEV_PASSWORD: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  fs.rmSync(temp, { recursive: true, force: true });
  assert.notEqual(code, 0);
  assert.match(stderr, /SALON_ADMIN_PASSWORD tanımlanmalıdır/);
});

test("dev.mjs does not start when NODE_ENV is production", async () => {
  const child = spawn(process.execPath, ["dev.mjs"], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, NODE_ENV: "production", SALON_ADMIN_PASSWORD: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.match(stderr, /üretim ortamında kullanılamaz/);
});

test("server.mjs exits when the development password is used without the starter", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cave-password-policy-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      PORT: String(37000 + Math.floor(Math.random() * 1000)),
      SALON_DB_PATH: path.join(temp, "salon.sqlite"),
      SALON_ADMIN_PASSWORD: "cave123",
      SALON_ALLOW_DEV_PASSWORD: "",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  fs.rmSync(temp, { recursive: true, force: true });
  assert.notEqual(code, 0);
  assert.match(stderr, /Geliştirme parolası yalnızca npm run dev:server/);
});
