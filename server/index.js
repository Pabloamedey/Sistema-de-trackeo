import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import express from "express";
import cors from "cors";
import { Server as IOServer } from "socket.io";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==== Estado compartido ====
let lastLocation = null;
let ioHttps; // se asignan luego de crear servers
let ioHttp;
let PUBLIC_TUNNEL_URL = null;

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

// ================== función para publicar dominio en Gist ==================
function updateDiscoveryGist(url) {
  const GIST_ID = process.env.GIST_ID;
  const GIST_TOKEN = process.env.GIST_TOKEN;
  if (!GIST_ID || !GIST_TOKEN) {
    console.warn("GIST_ID / GIST_TOKEN no seteados, omitiendo publicación");
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
          console.log("Discovery Gist actualizado correctamente");
        } else {
          console.warn("Falló actualización Gist:", res.statusCode, buf);
        }
      });
    }
  );

  req.on("error", (e) => console.warn("Error Gist:", e.message));
  req.write(body);
  req.end();
}

// ================== lanzar LocalXpose y publicar en Gist ==================
function startLocalXposeAndCaptureUrl() {
  const BIN = process.platform === "win32" ? "loclx.exe" : "loclx";
  const ports = [
    { port: 9876, label: "https-visor" },
    { port: 9878, label: "api-movil" },  // <— el que usará App.js
    { port: 8081, label: "expo" },
  ];

  const attachParsers = (child, label, port) => {
    const parse = (chunk) => {
      const s = chunk.toString();
      process.stdout.write(`[loclx:${label}] ${s}`);

      // acepta “xxxxx.loclx.io” con o sin protocolo
      const m = s.match(/(?:https?:\/\/)?([a-z0-9][a-z0-9-]*\.loclx\.io)/i);
      if (!m) return;
      const url = m[1].startsWith("http") ? m[1] : `https://${m[1]}`;

      // si es el del 9878, actualizamos la que usa la app
      if (port === 9878 && url !== PUBLIC_TUNNEL_URL) {
        PUBLIC_TUNNEL_URL = url;
        console.log(`Dominio principal (API móvil 9878): ${url}`);

        // publicar automáticamente en Gist
        updateDiscoveryGist(url);

      }
    };
    child.stdout.on("data", parse);
    child.stderr.on("data", parse); // LocalXpose suele escribir el status en stderr
  };

  ports.forEach(({ port, label }) => {
    const args = ["tunnel", "http", "--to", `localhost:${port}`];
    const child = spawn(BIN, args, { shell: true });
    attachParsers(child, label, port);
    child.on("close", (code) => console.log(`[loclx:${label}] cerrado con código`, code));
  });
}

// === Iniciar LocalXpose automáticamente al arrancar ===
startLocalXposeAndCaptureUrl();

// ==== App HTTPS (visor) ====
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../web-viewer"))); // servir visor (index.html) desde el mismo server

app.get("/health", (_req, res) => res.send("OK"));

// ---- Handler único /location (válido para ambos servers) ----
function handleLocation(req, res) {
  console.log("Body:", req.body);
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
    const d  = distanceMeters(prev, { lat, lon });

    // 1) ruido: movimiento muy chico y demasiado seguido
    if (d < SERVER_MIN_MOVE && dt < SERVER_MIN_SECONDS) {
      return res.send({ ok: true, skipped: "small_move" });
    }
    // 2) glitch: salto imposible (por precisión mala)
    if (dt > 0 && d / dt > SERVER_MAX_JUMP_SPEED) {
      console.warn(`Salto anómalo de ${d.toFixed(1)} m en ${dt.toFixed(2)} s para ${id}, ignorado`);
      return res.send({ ok: true, skipped: "glitch" });
    }
  }

  const loc = { userId: id, lat, lon, ts };
  lastByUser.set(id, loc);
  lastLocation = loc;

  // Emite a ambos canales
  ioHttps?.emit("locationUpdate", loc);
  ioHttp?.emit("locationUpdate", loc);

  console.log(
    `📥 ${id} -> ${lat.toFixed(6)}, ${lon.toFixed(6)} [${new Date(
      ts
    ).toLocaleTimeString()}]`
  );
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

httpsServer.listen(9876, () => {
  console.log(`🔒 HTTPS on https://${IP}:9876`);
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
appHttp.get("/current-tunnel", (_req, res) => {
  res.json({ server: PUBLIC_TUNNEL_URL });
});

// endpoint para servir el archivo con la URL actual
appHttp.get("/server-url.json", (req, res) => {
  const filePath = path.resolve(__dirname, "server-url.json");
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.json({ server: null });
  }
});


// landing con redirección bonita
appHttp.get("/", (_req, res) => {
  res.send(`
    <html>
      <head>
        <meta http-equiv="refresh" content="2;url=https://${IP}:9876/">
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
          <p>Si no ocurre automáticamente, <a href="https://${IP}:9876/">hacé clic acá</a>.</p>
        </div>
      </body>
    </html>
  `);
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
