import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-"));
const port = 33333;
const base = "http://127.0.0.1:" + port;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: path.dirname(fileURLToPath(import.meta.url)),
  env: { ...process.env, PORT: String(port), SALON_DB_PATH: path.join(tempDir, "s.sqlite"), SALON_ADMIN_PASSWORD: "test123" },
  stdio: ["ignore","pipe","pipe"],
});
server.stderr.on("data",(d)=>process.stderr.write(d));

async function wait() {
  for (let i=0;i<200;i++) {
    try { const r = await fetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}); if(r.status===401) return; } catch {}
    await new Promise(r=>setTimeout(r,50));
  }
}
async function api(p,opts) {
  const {method="GET",body,token}=opts||{};
  const r = await fetch(base+p,{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const pl = r.status===204?null:await r.json().catch(()=>null);
  return {status:r.status,payload:pl};
}

await wait();
const login = await api("/api/auth/login",{method:"POST",body:{password:"test123"}});
const token = login.payload.token;
const d1 = (await api("/api/devices",{method:"POST",token,body:{name:"Masa1"}})).payload;
const d2 = (await api("/api/devices",{method:"POST",token,body:{name:"Masa2"}})).payload;
const started = await api("/api/devices/"+d1.id+"/start",{method:"POST",token,body:{controllerCount:2}});
console.log("Started:", started.status, "session:", started.payload?.activeSession?.id);
const transfer = await api("/api/devices/"+d1.id+"/transfer",{method:"POST",token,body:{targetDeviceId:d2.id}});
console.log("Transfer:", transfer.status, JSON.stringify(transfer.payload?.error||"ok"));
const stop = await api("/api/devices/"+d2.id+"/stop",{method:"POST",token,body:{paymentMethod:"nakit"}});
console.log("Stop d2:", stop.status, JSON.stringify(stop.payload?.error||"ok"));
const undo = await api("/api/devices/"+d2.id+"/undo",{method:"POST",token});
console.log("Undo d2:", undo.status, JSON.stringify(undo.payload?.error||undo.payload?.device?.activeSession?.id));
const undo2 = await api("/api/devices/"+d2.id+"/undo",{method:"POST",token});
console.log("Undo d2 again:", undo2.status, JSON.stringify(undo2.payload?.error));

server.kill(); await once(server,"exit");
fs.rmSync(tempDir,{recursive:true,force:true});
