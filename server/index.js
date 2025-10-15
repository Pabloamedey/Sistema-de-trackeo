import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import express from "express";
import cors from "cors";
import { Server as IOServer } from "socket.io";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==== Estado compartido ====
let lastLocation = null;
let ioHttps; // se asignan luego de crear servers
let ioHttp;

// Estado por usuario y helpers
const lastByUser = new Map(); // userId -> { lat, lon, ts }

function distanceMeters(a, b) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat/2)**2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const SERVER_MIN_MOVE = 5;        // ignora cambios <5 m
const SERVER_MAX_JUMP_SPEED = 200; // ignora saltos imposibles >200 m/s
const SERVER_MIN_SECONDS = 1.0;   // ignora spam <1s si casi no hay movimiento

const IP = "192.168.100.73";

// ==== App HTTPS (visor) ====
const app = express();
app.use(cors());
app.use(express.json());

// servir visor (index.html) desde el mismo server
app.use(express.static(path.resolve(__dirname, "../web-viewer")));

app.get("/health", (_req, res) => res.send("OK"));

// ---- Handler único /location (válido para ambos servers) ----
function handleLocation(req, res) {
  console.log("🧾 Body crudo:", req.body);
  let { userId, lat, lon, ts } = req.body || {};
  lat = Number(lat); lon = Number(lon); ts = Number(ts) || Date.now();

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.warn("⚠️  Ubicación inválida recibida:", req.body);
    return res.status(400).send("Missing or invalid coords");
  }

  const id = String(userId ?? "anon");
  const prev = lastByUser.get(id);

  if (prev) {
    const dt = (ts - prev.ts) / 1000;
    const d  = distanceMeters(prev, { lat, lon });

    // 1) ruido: movimiento muy chico y demasiado seguido
    if (d < SERVER_MIN_MOVE && dt < SERVER_MIN_SECONDS) {
      return res.send({ ok: true, skipped: "small_move" });
    }
    // 2) glitch: salto imposible (por precisión mala)
    if (dt > 0 && d / dt > SERVER_MAX_JUMP_SPEED) {
      console.warn(`⚠️  Salto anómalo de ${d.toFixed(1)} m en ${dt.toFixed(2)} s para ${id}, ignorado`);
      return res.send({ ok: true, skipped: "glitch" });
    }
  }

  const loc = { userId: id, lat, lon, ts };
  lastByUser.set(id, loc);
  lastLocation = loc; // mantiene compat con tu visor actual (último en general)

  // Emití a ambos canales
  ioHttps?.emit("locationUpdate", loc);
  ioHttp?.emit("locationUpdate", loc);

  console.log(`📥 ${id} -> ${lat.toFixed(6)}, ${lon.toFixed(6)} [${new Date(ts).toLocaleTimeString()}]`);
  res.send({ ok: true });
}


// HTTPS (visor seguro + sockets)
const credentials = {
  key: fs.readFileSync(path.resolve(__dirname, `./certs/${IP}+1-key.pem`)),
  cert: fs.readFileSync(path.resolve(__dirname, `./certs/${IP}+1.pem`)),
};
const httpsServer = https.createServer(credentials, app);
ioHttps = new IOServer(httpsServer, { cors: { origin: "*" } });

ioHttps.on("connection", (socket) => {
  console.log("Dispositivo conectado (HTTPS):", socket.id);
  if (lastLocation) socket.emit("locationUpdate", lastLocation);
});

// registrar /location en HTTPS también (útil para pruebas desde el visor)
app.post("/location", handleLocation);

httpsServer.listen(4000, () => {
  console.log(`🔒 HTTPS on https://${IP}:4000`);
});

// ==== App HTTP (API para la app móvil) ====
const appHttp = express();
appHttp.use(express.json());

// logger básico
appHttp.use((req, _res, next) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`📡 HTTP ${req.method} ${req.url} <- ${ip} | ct=${req.headers["content-type"]}`);
  next();
});

// rutas API (misma lógica que HTTPS)
appHttp.post("/location", handleLocation);
appHttp.get("/health", (_req, res) => res.send("OK"));

// landing con redirección bonita
appHttp.get("/", (_req, res) => {
  res.send(`
    <html>
      <head>
        <meta http-equiv="refresh" content="2;url=https://${IP}:4000/">
        <title>Redirigiendo...</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background: #fafafa;
            margin: 0;
          }
          .box {
            width: 360px;
            text-align: center;
            padding: 2rem;
            border: 1px solid #ccc;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            background: #fff;
          }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>🔒 Redirigiendo al visor seguro...</h2>
          <p>Si no ocurre automáticamente, <a href="https://${IP}:4000/">hacé clic acá</a>.</p>
        </div>
      </body>
    </html>
  `);
});

const httpServer = http.createServer(appHttp);
ioHttp = new IOServer(httpServer, { cors: { origin: "*" } });

ioHttp.on("connection", (socket) => {
  console.log("Dispositivo conectado (HTTP 4002):", socket.id);
  if (lastLocation) socket.emit("locationUpdate", lastLocation);
});

httpServer.listen(4002, () => {
  console.log(`🌐 HTTP (app) on http://${IP}:4002`);
});
