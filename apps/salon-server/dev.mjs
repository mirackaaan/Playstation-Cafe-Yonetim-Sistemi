import { applyDevelopmentAdminPassword } from "./admin-password.mjs";

applyDevelopmentAdminPassword();

await import("./server.mjs");
