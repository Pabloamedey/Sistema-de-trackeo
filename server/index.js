// index.js — server + tunnels + gist (CERTS MANUALES)
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import express from "express";
import cors from "cors";
import { Server as IOServer } from "socket.io";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

// ================= rutas base =================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= estado compartido =================
let lastLocation = null;
let ioHttps; // sockets sobre 9876 (https)
let ioHttp;  // sockets sobre 9878 (http)
let PUBLIC_TUNNEL_URL = null; // dominio público (9878) publicado en Gist

// mapa de última ubicación por usuario
const lastByUser = new Map(); // userId -> { lat, lon, ts }

// ================= helpers =================
function distanceMeters(a, b) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// filtros de servidor (anti-spam básicos)
const SERVER_MIN_MOVE = 5;         // m mínimos entre muestras
const SERVER_MAX_JUMP_SPEED = 200; // m/s anti-glitch
const SERVER_MIN_SECONDS = 1.0;    // s mínimos entre muestras

// ======================= CERTS MANUALES =======================
// CAMBIO: IP fija y lectura de certs/keys manuales (sin selfsigned)
const IP = "192.168.100.73"; // <-- poné acá la IP local de la máquina
const credentials = {
  key: fs.readFileSync(path.resolve(__dirname, `./certs/${IP}-key.pem`)),
  cert: fs.readFileSync(path.resolve(__dirname, `./certs/${IP}.pem`)),
};
// =============================================================


// ================== publicar dominio en Gist (opcional) ==================
function updateDiscoveryGist(url) {
  const GIST_ID = process.env.GIST_ID;
  const GIST_TOKEN = process.env.GIST_TOKEN;
  if (!GIST_ID || !GIST_TOKEN) {
    console.warn("⚠️  GIST_ID / GIST_TOKEN no seteados, omitiendo publicación");
    return;
  }

  const body = JSON.stringify({
    files: {
      "current-tunnel.json": {
        content: JSON.stringify({ server: url }),
      },
    },
  });

  const req = https.request(
    {
      hostname: "api.github.com",
      path: `/gists/${GIST_ID}`,
      method: "PATCH",
      headers: {
        "User-Agent": "loclx-discovery",
        "Authorization": `Bearer ${GIST_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log("☁️  Discovery Gist actualizado correctamente");
        } else {
          console.warn("⚠️  Falló actualización Gist:", res.statusCode, buf);
        }
      });
    }
  );

  req.on("error", (e) => console.warn("⚠️  Error Gist:", e.message));
  req.write(body);
  req.end();
}

// ================== LocalXpose: lanzar túneles y capturar URLs ==================
function startLocalXposeAndCaptureUrl() {
  const BIN = process.platform === "win32" ? "loclx.exe" : "loclx";
  const ports = [
    { port: 9876, label: "https-visor" },
    { port: 9878, label: "api-movil" },
    { port: 8081, label: "expo" },
  ];

  const attachParsers = (child, label, port) => {
    const parse = (chunk) => {
      const s = chunk.toString();
      process.stdout.write(`[loclx:${label}] ${s}`);

      // Dominio público detectado en salida
      const m = s.match(/(?:https?:\/\/)?([a-z0-9][a-z0-9-]*\.loclx\.io)/i);
      if (!m) return;

      // Si no trae protocolo, asumimos http:// (LocalXpose suele decir "(http, us)")
      const url = m[1].startsWith("http") ? m[1] : `http://${m[1]}`;

      // Log lindo con mapping a puerto local
      const fullUrl = `${url} → localhost:${port}`;
      if (port === 9878 && url !== PUBLIC_TUNNEL_URL) {
        PUBLIC_TUNNEL_URL = url;
        console.log(`🌍 Dominio principal (API móvil 9878): ${fullUrl}`);

        // publicar Gist para discovery externo
        updateDiscoveryGist(url);
      } else {
        console.log(`🔗 Dominio ${label}: ${fullUrl}`);
      }

      // Detección del puerto del GUI (si ejecutás 'loclx gui' por separado y suelta la línea)
      const guiMatch = s.match(/http:\/\/localhost:(\d+)/);
      if (guiMatch) {
        console.log(`📟 LocalXpose GUI: http://localhost:${guiMatch[1]}`);
      }
    };

    child.stdout.on("data", parse);
    child.stderr.on("data", parse);
  };

  // lanzar túnel por puerto
  ports.forEach(({ port, label }) => {
    const args = ["tunnel", "http", "--to", `localhost:${port}`];
    const child = spawn(BIN, args, { shell: true });
    attachParsers(child, label, port);
    child.on("close", (code) => console.log(`[loclx:${label}] cerrado con código`, code));
  });

  // (opcional) lanzar GUI — si lo usás, queda acá
  try {
    const gui = spawn(BIN, ["gui"], { shell: true });
    gui.stdout.on("data", (buf) => {
      const s = buf.toString();
      process.stdout.write(`[loclx:gui] ${s}`);
      const match = s.match(/http:\/\/localhost:(\d+)/);
      if (match) console.log(`📟 LocalXpose GUI: http://localhost:${match[1]}`);
    });
    gui.stderr.on("data", (e) => process.stderr.write(`[loclx:gui:err] ${e}`));
  } catch (_) {}
}

// === Iniciar LocalXpose automáticamente ===
startLocalXposeAndCaptureUrl();


// ================== EXPRESS: HTTPS (visor) ==================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../web-viewer")));

app.get("/health", (_req, res) => res.send("OK"));

// handler común /location
function handleLocation(req, res) {
  let { userId, lat, lon, ts } = req.body || {};
  lat = Number(lat);
  lon = Number(lon);
  ts = Number(ts) || Date.now();

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.warn("Ubicación inválida recibida:", req.body);
    return res.status(400).send("Missing or invalid coords");
  }

  const id = String(userId ?? "anon");
  const prev = lastByUser.get(id);

  if (prev) {
    const dt = (ts - prev.ts) / 1000;
    const d = distanceMeters(prev, { lat, lon });

    if (d < SERVER_MIN_MOVE && dt < SERVER_MIN_SECONDS) {
      return res.send({ ok: true, skipped: "small_move" });
    }

    if (dt > 0 && d / dt > SERVER_MAX_JUMP_SPEED) {
      console.warn(`Salto anómalo de ${d.toFixed(1)} m en ${dt.toFixed(2)} s para ${id}, ignorado`);
      return res.send({ ok: true, skipped: "glitch" });
    }
  }

  const loc = { userId: id, lat, lon, ts };
  lastByUser.set(id, loc);
  lastLocation = loc;

  ioHttps?.emit("locationUpdate", loc);
  ioHttp?.emit("locationUpdate", loc);

  console.log(`📥 ${id} -> ${lat.toFixed(6)}, ${lon.toFixed(6)} [${new Date(ts).toLocaleTimeString()}]`);
  res.send({ ok: true });
}

const httpsServer = https.createServer(credentials, app);
ioHttps = new IOServer(httpsServer, { cors: { origin: "*" } });

ioHttps.on("connection", (socket) => {
  console.log("Dispositivo conectado (HTTPS):", socket.id);
  if (lastLocation) socket.emit("locationUpdate", lastLocation);
});

app.post("/location", handleLocation);

httpsServer.listen(9876, () => {
  console.log(`🔒 HTTPS on https://${IP}:9876`);
});


// ================== EXPRESS: HTTP (API móvil) ==================
const appHttp = express();
appHttp.use(express.json());
appHttp.use((req, _res, next) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`📡 HTTP ${req.method} ${req.url} <- ${ip}`);
  next();
});

appHttp.post("/location", handleLocation);
appHttp.get("/health", (_req, res) => res.send("OK"));

// para discovery local (LAN)
appHttp.get("/current-tunnel", (_req, res) => res.json({ server: PUBLIC_TUNNEL_URL }));

// (opcional) JSON directo que refleja PUBLIC_TUNNEL_URL
appHttp.get("/server-url.json", (_req, res) => {
  res.json({ server: PUBLIC_TUNNEL_URL });
});

appHttp.get("/", (_req, res) => {
  res.send(`<html><body><h2>Servidor móvil activo en puerto 9878</h2></body></html>`);
});

const httpServer = http.createServer(appHttp);
ioHttp = new IOServer(httpServer, { cors: { origin: "*" } });

ioHttp.on("connection", (socket) => {
  console.log("Dispositivo conectado (HTTP 9878):", socket.id);
  if (lastLocation) socket.emit("locationUpdate", lastLocation);
});

httpServer.listen(9878, "0.0.0.0", () => {
  console.log(`🌐 HTTP (app) on http://${IP}:9878`);
});
