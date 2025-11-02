// App.js
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as FileSystem from "expo-file-system/legacy";
import * as Location from "expo-location";
import * as MediaLibrary from "expo-media-library";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Linking, Modal, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import 'react-native-get-random-values';
import MapView, { Marker, Polyline } from "react-native-maps";
import { io } from "socket.io-client";
import { v4 as uuidv4 } from "uuid";

// Evitar logs repetidos de valores iguales
const lastLogs = new Map();

function logChanged(key, value) {
  const last = lastLogs.get(key);
  if (last !== value) {
    console.log(`💡 ${key}:`, value);
    lastLogs.set(key, value);
  }
}

// Comprobar si el dispositivo se mueve o no
const minMoveMeters = 7;     // umbral de movimiento
const masStaleSeconds = 15;  // manda un heartbeat como máximo cada 30s
const minSpeedMs = 0.6;      // quieto si va < 1 m/s
//maxAcceptableAcc
// calidad mínima de la muestra y confirmación de movimiento
const maxAcceptableAcc = 20; // precisión máx (en m) para considerar la muestra
const consecConfirm = 2;      // muestras consecutivas para confirmar movimiento

function haversine(a, b) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000; // m
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

export default function App() {
  // identidad / UI
  const [userId, setUserId] = useState("anon"); // ID persistente legible (nombre-dispositivo + uuid corto)
  const [tracking, setTracking] = useState(false);
  const [myCoord, setMyCoord] = useState(null);
  const [initialRegion, setInitialRegion] = useState(null);
  const [currentSpeed, setCurrentSpeed] = useState(0);

  // remoto
  const [targetCoord, setTargetCoord] = useState(null);
  const [path, setPath] = useState([]);

  // server discovery
  const [serverUrl, setServerUrl] = useState(null);
  const [statusMsg, setStatusMsg] = useState("Descubriendo servidor…");
  const [serverReady, setServerReady] = useState(false);

  // sesión local (agrupado)
  const [session, setSession] = useState({
    active: false,
    points: [],
    distance: 0,
    avgSpeed: 0,
    totalSpeed: 0,    
    speedSamples: 0,
  });

  // refs operativos
  const mapRef = useRef(null);
  const socketRef = useRef(null);
  const watchRef = useRef(null);
  const lastSentRef = useRef({ coord: null, ts: 0 });
  const moveConfirmRef = useRef(0);
  const sessionActiveRef = useRef(false);
  // menus y botones
  const [showMenu, setShowMenu] = useState(false);
  const [sessionsModalVisible, setSessionsModalVisible] = useState(false);
  const [savedSessions, setSavedSessions] = useState([]);
  const [elapsedSec, setElapsedSec] = useState(0);
  const timerRef = useRef(null);

  const GIST_USER = "Pabloamedey";
  const GIST_ID   = "123f37bd1e8b7b1612f2f567d5cf0e49";

  // Proveedores de discovery (ordenado del más robusto al más frágil)
  function buildDiscoveryProviders() {
    const now = Date.now(); // cache-buster
    return [
      // gist.githubusercontent.com (último recurso: se rate-limita fácil)
      {
        name: "gist.githubusercontent.com",
        url: `https://gist.githubusercontent.com/${GIST_USER}/${GIST_ID}/raw/current-tunnel.json?t=${now}`,
        parse: async (res) => {
          const j = await res.json();
          return j?.server || null;
        },
        headers: {
          "User-Agent": "pepi-tracker/1.0",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
        },
      },
    ];
  }
  // obtiene el dominio (https://xxxxx.loclx.io) desde el Gist
  async function getDynamicServer() {
    const providers = buildDiscoveryProviders();

    for (const p of providers) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(p.url, { cache: "no-store", headers: p.headers, signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) {
          logChanged(`Discovery ${p.name} falló: status ${res.status}`);
          continue;
        }
        const server = await p.parse(res);
        if (server && /^https?:\/\/.+/i.test(server)) {
          logChanged(`Discovery OK via ${p.name}: ${server}`);
          return server;
        }
        logChanged(`Discovery ${p.name} sin 'server' válido`);
      } catch (e) {
        logChanged(`Discovery ${p.name} error: ${e.message}`);
      }
    }

    return null;
  }

  // asegura tener serverUrl (1) discovery público -> (2) cache
    async function ensureServerUrl() {
    // 1) probar red primero con multi-proveedor
    for (let i = 0; i < 3; i++) {
      const fresh = await getDynamicServer();
      if (fresh) {
        const cached = await AsyncStorage.getItem("serverUrl");
        if (cached !== fresh) {
          logChanged("serverUrl", `🔄 Actualizando cache: ${cached} => ${fresh}`);
          await AsyncStorage.setItem("serverUrl", fresh);
        }
        setServerUrl(fresh);
        return fresh;
      }
      logChanged("Reintentando discovery en 3s...");
      await new Promise(r => setTimeout(r, 3000));
    }

    // 2) fallback a cache (último recurso)
    const cached = await AsyncStorage.getItem("serverUrl");
    if (cached && /^https?:\/\/.+/i.test(cached)) {
      setServerUrl(cached);
      return cached;
    }

    Alert.alert("No se pudo obtener el dominio del servidor");
    return null;
  }

    // Helpers para abrir/copiar visor/admin ===
  const normalizeBase = (u) => (u ? u.replace(/\/+$/, "") : null);

  const buildViewerUrl = (base) => `${normalizeBase(base)}/`;

  // Acciones de visor/admin ===
  const openViewerInBrowser = async () => {
    const base = await ensureServerUrl();
    if (!base) return Alert.alert("Sin dominio público", "No se pudo resolver la URL del servidor.");
    const url = buildViewerUrl(base);
    Linking.openURL(url);
  };

  const copyViewerUrl = async () => {
    const base = await ensureServerUrl();
    if (!base) return Alert.alert("Sin dominio público", "No se pudo resolver la URL del servidor.");
    const url = buildViewerUrl(base);
    await Clipboard.setStringAsync(url);
    Alert.alert("URL copiada", url);
  };

  // bootstrap del serverUrl al iniciar
  useEffect(() => {
    (async () => {
      const url = await ensureServerUrl();
      setServerReady(url);
      if (!url) setStatusMsg("No hay serverUrl disponible (ver Gist)");
    })();
  }, []);

  // reintento pasivo cada 15s por si cambió el subdominio
  useEffect(() => {
    const id = setInterval(async () => {
      const dyn = await getDynamicServer();
      if (!dyn) return;

      const newUrl = normalizeBase(dyn);
      const current = normalizeBase(serverUrl);

      if (!current || newUrl !== current) {
        logChanged("discovery-interval", `💡 Dominio actualizado: ${current} => ${newUrl}`);
        setServerUrl(newUrl);
        setStatusMsg(`Dominio actualizado: ${newUrl}`);
      }
    }, 15000);

    return () => clearInterval(id);
  }, [serverUrl]);

  // heartbeat forzado por si el GPS no dispara cuando el celu está quieto
  useEffect(() => {
    // chequeamos más seguido que 30s (cada 5s)
    const id = setInterval(async () => {
      // si no estoy trackeando, no hago nada
      if (!tracking) return;

      // si no hay server, nada
      if (!serverUrl) return;

      // si todavía no tengo una coord válida, nada
      if (!myCoord) return;

      const last = lastSentRef.current;
      const now = Date.now();
      const elapsed = (now - (last?.ts || 0)) / 1000;

      // si pasaron 30s desde lo último que MANDÉ → mando heartbeat
      if (elapsed >= masStaleSeconds) {
        try {
          await postLocation(serverUrl, {
            userId,
            latitude: myCoord.latitude,
            longitude: myCoord.longitude,
            ts: now,
            heartbeat: true,
          });

          // actualizo refs como si el watcher hubiera mandado
          lastSentRef.current = { coord: myCoord, ts: now };
          // si se quiere guardar también el último heartbeat:
          // lastHeartbeatRef.current = now;

        } catch (e) {
          console.log("Error enviando heartbeat forzado:", e.message);
        }
      }
    }, 3000); // chequea cada 5s

    return () => clearInterval(id);
  }, [tracking, serverUrl, myCoord, userId]);

  // Crear / Leer ID persistente + nombre del dispositivo
  useEffect(() => {
  (async () => {
    try {
      console.log("Iniciando carga del ID persistente...");
      let savedId = await AsyncStorage.getItem("deviceId");
      if (!savedId) {
        savedId = uuidv4();
        await AsyncStorage.setItem("deviceId", savedId);
        console.log("Nuevo ID guardado:", savedId);
      } else {
        console.log("ID existente encontrado:", savedId);
      }

      const shortId = savedId.slice(0, 8);

      let deviceName = null;
      try {
        // Obtenemos nombre del dispositivo (ej: "Galaxy A52")
        deviceName =
          Device.deviceName ||
          Device.modelName ||
          "Dispositivo";
      } catch (err) {
        console.log("Error al obtener nombre del dispositivo:", err.message);
        deviceName = Device.modelName || "Dispositivo";
      }

      console.log("Nombre del dispositivo:", deviceName);
      // ID compuesto: nombre + ID corto
      setUserId(`${deviceName}-${shortId}`);
    } catch (e) {
      console.log("Error general en useEffect de ID persistente:", e.message);
      setUserId(`device-${Math.floor(Math.random() * 10000)}`);
    }
  })();
}, []);


    // Obtener ubicación inicial al iniciar la app (solo para centrar el mapa)
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        alert("Se requiere permiso de ubicación para mostrar el mapa");
        return;
      }

      const location = await Location.getCurrentPositionAsync({});
      const { latitude, longitude } = location.coords;
      setInitialRegion({
        latitude,
        longitude,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02,
      });
    })();
  }, []);

    // Socket para ver al “seguido” en tiempo real
    useEffect(() => {
        if (!serverUrl || !userId) return;
        setStatusMsg(`🧩 Conectando a ${serverUrl}…`);
        try {
        socketRef.current = io(serverUrl, { transports: ["websocket", "polling"] });
        } catch (e) {
        setStatusMsg(`Error creando socket: ${e.message}`);
        return;
        }

        // Cuando se conecta el socket
        socketRef.current.on("connect", () => {
        setStatusMsg(`✅ Conectado a ${serverUrl}`);
        // Unirse al room correspondiente a este usuario
        socketRef.current.emit("hello", { userId });
        });

        // Si ocurre un error de conexión
        socketRef.current.on("connect_error", (err) => {
        setStatusMsg(`Socket error: ${err?.message || err}`);
        });

        // Recibir actualizaciones de ubicación del propio usuario
        // (el server emite 'selfLocation' al room user:<id>)
        socketRef.current.on("selfLocation", ({ lat, lon }) => {
        const p = { latitude: lat, longitude: lon };
        setTargetCoord(p);
        setPath((prev) => [...prev, p]);
        mapRef.current?.animateToRegion(
            { ...p, latitudeDelta: 0.01, longitudeDelta: 0.01 },
            600
        );
        });

        // Limpieza al desmontar o cambiar serverUrl/userId
        return () => socketRef.current?.disconnect();
    }, [serverUrl, userId]);

  // ====== helper para enviar una ubicación única ======
  async function postLocation(url, { userId, latitude, longitude, ts, heartbeat }) {
    await fetch(`${url}/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        lat: latitude,
        lon: longitude,
        ts,
        heartbeat,   // 👈 ahora sí viaja
      }),
    });
  }

  useEffect(() => {
    // cuando empieza a trackear → arrancamos timer
    if (tracking) {
      // limpiamos uno viejo si había
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      // arrancamos en 0
      setElapsedSec(0);
      timerRef.current = setInterval(() => {
        setElapsedSec((prev) => prev + 1);
      }, 1000);
    } else {
      // cuando detiene → paramos y reseteamos
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      setElapsedSec(0);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [tracking]);

   // ====== Funciones para sesiones ======
  const startSession = () => {
    setSession({
      active: true,
      points: [],
      distance: 0,
      avgSpeed: 0,
      totalSpeed: 0,
      speedSamples: 0,
    });
    sessionActiveRef.current = true;
  };

  const stopSession = () => {
    setSession((prev) => ({ ...prev, active: false }));
    sessionActiveRef.current = false;
  };

  // Enviar mi ubicación con el ID persistente
  const startTracking = async () => {
    // 1) asegurá serverUrl real antes de arrancar
    const url = await ensureServerUrl();
    console.log("POST /location contra:", url);
    if (!url) {
      Alert.alert("Sin dominio disponible", "No se pudo conectar al servidor.");
      return;
    }

    // 2) permisos
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      return alert("Permiso de ubicación denegado");
    }

    setTracking(true);
    setCurrentSpeed(0);
    startSession();  

    // 3) limpiar watcher anterior si hubiera
    if (watchRef.current) {
      try { await watchRef.current.remove(); } catch {}
      watchRef.current = null;
    }

    const now = Date.now();

    // 4) PRIMER DISPARO ULTRA-RÁPIDO con la última ubicación conocida (si existe)
    try {
      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown) {
        const { latitude, longitude } = lastKnown.coords;
        setMyCoord({ latitude, longitude });
        await postLocation(url, { userId, latitude, longitude, ts: now - 1 }); // ts un pelín antes
        lastSentRef.current = { coord: { latitude, longitude }, ts: now - 1 };
        moveConfirmRef.current = 0;
        socketRef.current?.emit("hello", { userId });
        console.log("📤 enviada lastKnown inmediata");
      }
    } catch (e) {
      console.log("No había lastKnown:", e.message);
    }

     // 4B) EN PARALELO pedimos una posición buena y la mandamos
    (async () => {
      try {
        const first = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.BestForNavigation,
        });
        const { latitude, longitude } = first.coords;
        const ts = Date.now();
        setMyCoord({ latitude, longitude });
        await postLocation(url, { userId, latitude, longitude, ts });
        lastSentRef.current = { coord: { latitude, longitude }, ts };
        moveConfirmRef.current = 0;
        socketRef.current?.emit("hello", { userId });
        console.log("📤 enviada posición precisa inicial");
      } catch (e) {
        console.log("Error primer getCurrentPositionAsync:", e.message);
      }
    })();

    // 5) recién ahora arrancá el watcher continuo
    watchRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 1,
        mayShowUserSettingsDialog: true,
      },
      async (loc) => {
        const { latitude, longitude, speed, accuracy } = loc.coords;
        const rawSpeed = typeof speed === "number" ? speed : 0;
        setCurrentSpeed(rawSpeed);
        const now = Date.now();
        const current = { latitude, longitude };

        // siempre actualizamos en pantalla
        setMyCoord(current);

        // ------------------------------
        // 1) CÁLCULO DE MOVIMIENTO REAL
        // ------------------------------
        const last = lastSentRef.current;
        const dist = last.coord ? haversine(last.coord, current) : Infinity;
        const elapsed = (now - last.ts) / 1000;
        const heartbeatDue = elapsed >= masStaleSeconds;

        // precisión de esta muestra
        const acc = accuracy ?? 9999;

        // ruido típico de GPS: si me moví menos que el error, probablemente no me moví
        const probablyJustNoise = acc > 10 && dist < acc;

        // velocidad bajita = quieto
        const stillBySpeed = (typeof speed === "number" ? speed : 0) < minSpeedMs;
        
        // ¿moverse por distancia?
        const movedByDistance = dist >= minMoveMeters;

        // esto es para el SERVER
        if (movedByDistance && !stillBySpeed && !probablyJustNoise) {
          moveConfirmRef.current += 1;
        } else {
          moveConfirmRef.current = 0;
        }

        const movementConfirmed = moveConfirmRef.current >= consecConfirm;

        // ------------------------------
        // 2) DECISIÓN PARA LA SESIÓN
        // ------------------------------

        // reglas más relajadas para la SESIÓN
        const sessionDistThreshold = 2; // sumar a partir de 3m
        const goodEnoughAcc = 30; // hasta 15m aceptamos para sesión
        const stopped = rawSpeed < 0.3;
        // para la sesión NO queremos heartbeats ni ruido
        const shouldCountForDistance =
          sessionActiveRef.current &&       // que la sesión esté prendida
          !stopped &&                       // no sumar si ya estoy parado
          dist >= sessionDistThreshold &&   // que haya un movimiento mínimo
          acc <= goodEnoughAcc;             // precisión razonable

        if (shouldCountForDistance) {
          setSession((prev) => {
            const newPoint = {
              lat: latitude,
              lon: longitude,
              ts: now,
              speed: rawSpeed,
            };

            // primer punto de la sesión
            if (prev.points.length === 0) {
              return {
                ...prev,
                active: true,
                points: [newPoint],
                distance: 0,
                avgSpeed: 0,
                totalSpeed: rawSpeed > 0.3 ? rawSpeed : 0,
                speedSamples: rawSpeed > 0.3 ? 1 : 0,
              };
            }
            
            // puntos siguientes
            const lastPt = prev.points[prev.points.length - 1];
            const dSess = haversine(
              { latitude: lastPt.lat, longitude: lastPt.lon },
              { latitude, longitude }
            );

            // sumar solo si es ≥ 1m
            const distToAdd = dSess >= 1 ? dSess : 0;
            const newDistance = prev.distance + distToAdd;

            // promedio por tiempo (backup)
            const t0 = prev.points[0].ts;
            const totalSeconds = (now - t0) / 1000;
            const newAvg = totalSeconds > 0 ? newDistance / totalSeconds : 0;

            // promedio por velocidad real
            const isValidSpeed = rawSpeed > 0.3;
            const newTotalSpeed = prev.totalSpeed + (isValidSpeed ? rawSpeed : 0);
            const newSpeedSamples = prev.speedSamples + (isValidSpeed ? 1 : 0);
            const avgBySpeed = newSpeedSamples > 0 ? newTotalSpeed / newSpeedSamples : newAvg;

            return {
              ...prev,
              points: [...prev.points, newPoint],
              distance: newDistance,
              avgSpeed: avgBySpeed,
              totalSpeed: newTotalSpeed,
              speedSamples: newSpeedSamples,
            };
          });
        }

        // ------------------------------
        // 3) DECISIÓN PARA EL SERVER
        // ------------------------------
        const shouldSendToServer = movementConfirmed || heartbeatDue;

        // descartar muestras muy malas si no toca heartbeat
        if (acc > maxAcceptableAcc && !heartbeatDue) {
          return;
        }

        if (!shouldSendToServer) {
          // podés mover el mapa si querés
          if (dist > 3) {
            mapRef.current?.animateToRegion(
              { ...current, latitudeDelta: 0.01, longitudeDelta: 0.01 },
              400
            );
          }
          return;
        }

        // si llegamos acá => mandar
        try {
          await postLocation(serverUrl, {
            userId,
            latitude,
            longitude,
            ts: now,
            heartbeat: heartbeatDue ? true : undefined,
          });

          if (movementConfirmed) {
            moveConfirmRef.current = 0;
          }
          lastSentRef.current = { coord: current, ts: now };

          if (dist > minMoveMeters) {
            mapRef.current?.animateToRegion(
              { ...current, latitudeDelta: 0.01, longitudeDelta: 0.01 },
              400
            );
          }
        } catch (e) {
          console.log("Error enviando ubicación:", e.message);
        }
      }
    );
  };

  const stopTracking = async () => {
    setTracking(false);
    stopSession();
    // limpiar el watcher si existe
    if (watchRef.current) {
      try {
        await watchRef.current.remove();
      } catch {}
      watchRef.current = null;
    }
  };

  async function exportSessionToFile(payload) {
    try {
      const json = JSON.stringify(payload, null, 2);
      const safeName = payload.at.replace(/[:.]/g, "-");
      const fileName = `session-${safeName}.json`;
      const fileUri = FileSystem.documentDirectory + fileName;

      // 1) siempre guardamos en la carpeta interna de la app
      await FileSystem.writeAsStringAsync(fileUri, json);

      // 2) si estamos en Expo Go → NO intentamos MediaLibrary
      const isExpoGo = Constants.appOwnership === "expo";
      if (isExpoGo) {
        Alert.alert(
          "Guardado interno",
          "La sesión se guardó en la app."
        );
        return;
      }

      // 3) (solo build propio) pedimos permiso
      const { status } = await MediaLibrary.requestPermissionsAsync({
        // esto a veces ayuda a no pedir audio
        writeOnly: true,
      });

      if (status !== "granted") {
        Alert.alert(
          "Guardado interno",
          "La sesión se guardó en la app, pero no tengo permiso para guardarla en el dispositivo."
        );
        return;
      }

      // 4) creamos asset/álbum
      const asset = await MediaLibrary.createAssetAsync(fileUri);
      await MediaLibrary.createAlbumAsync("Trackeo", asset, false);

      Alert.alert("Guardado", "La sesión se guardó en el dispositivo.");
    } catch (e) {
      Alert.alert("Error", "No se pudo exportar la sesión: " + e.message);
    }
  }

  // guardar recorrido en telefono
  const saveSessionToDevice = async () => {
    if (session.points.length === 0) {
      Alert.alert("Nada para guardar", "No hay puntos en esta sesión.");
      return;
    }

    const payload = {
      at: new Date().toISOString(),
      userId,
      distance: session.distance,
      points: session.points,
    };

    try {
      // guardado interno
      const prev = await AsyncStorage.getItem("savedSessions");
      const arr = prev ? JSON.parse(prev) : [];
      arr.push(payload);
      await AsyncStorage.setItem("savedSessions", JSON.stringify(arr));
    } catch (e) {
      Alert.alert("Error", "No se pudo guardar la sesión internamente: " + e.message);
      return;
    }

    // intento exportar a archivo
    await exportSessionToFile(payload);
  };

  const showSavedSessions = async () => {
    try {
      const prev = await AsyncStorage.getItem("savedSessions");
      const arr = prev ? JSON.parse(prev) : [];

      if (!arr.length) {
        Alert.alert("Sesiones", "No tenés sesiones guardadas todavía.");
        return;
      }

      // más nuevas primero
      const sorted = [...arr].sort(
        (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
      );

      setSavedSessions(sorted);
      setSessionsModalVisible(true);
    } catch (e) {
      Alert.alert("Error", "No pude leer las sesiones: " + e.message);
    }
  };

    // Construye una URL de Google Maps con la ubicación actual
    const buildMapsUrl = (lat, lon) =>
      `https://www.google.com/maps?q=${lat},${lon}`;

    // Abre el cliente de correo con los datos prellenados
    const shareCurrentLocationByEmail = async () => {
      if (!myCoord) {
        Alert.alert("Sin ubicación", "Todavía no tengo una posición válida.");
        return;
      }

      const lat = myCoord.latitude.toFixed(6);
      const lon = myCoord.longitude.toFixed(6);
      const mapsUrl = buildMapsUrl(lat, lon);

      // opcional: link al visor web (si lo resolvió)
      const viewer = serverUrl ? `${serverUrl.replace(/\/+$/, "")}/` : "";

      const subject = encodeURIComponent(
        `Ubicación actual de ${userId}`
      );

      const bodyLines = [
        `Dispositivo: ${userId}`,
        `Latitud: ${lat}`,
        `Longitud: ${lon}`,
        "",
        `Ver en Google Maps: ${mapsUrl}`,
      ];

      if (viewer) {
        bodyLines.push("", `Ver en visor web: ${viewer}`);
      }

      const body = encodeURIComponent(bodyLines.join("\n"));

      const mailto = `mailto:?subject=${subject}&body=${body}`;

      try {
        const canOpen = await Linking.canOpenURL(mailto);
        if (canOpen) {
          await Linking.openURL(mailto);
        } else {
          Alert.alert("No se pudo abrir el correo");
        }
      } catch (e) {
        Alert.alert("Error", "No se pudo abrir el cliente de correo: " + e.message);
      }
    };

  // velocidad
  const toKmh = (ms) => (ms * 3.6).toFixed(1);
  // distnacia
  const formatDistance = (m) => {
    if (!m || m <= 0) return "0.000 km";
    return `${(m / 1000).toFixed(3)} km`;
  };

  const formatDuration = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${h.toString().padStart(2,"0")}:${m
        .toString()
        .padStart(2,"0")}:${s.toString().padStart(2,"0")}`;
    }
    return `${m.toString().padStart(2,"0")}:${s.toString().padStart(2,"0")}`;
  };
  
return (
  <View style={styles.container}>
    {/* Mapa */}
    {Platform.OS !== "web" ? (
      initialRegion ? (
        <MapView ref={mapRef} style={styles.map} initialRegion={initialRegion}>
          {myCoord && (
            <Marker
              coordinate={myCoord}
              title={`📱 ${userId}`}
              pinColor="blue"
            />
          )}
          {targetCoord && (
            <Marker coordinate={targetCoord} title="📍 Tracker seguido" />
          )}
          {path.length > 1 && <Polyline coordinates={path} />}
        </MapView>
      ) : (
        <View style={styles.centered}>
          <Text style={styles.centeredText}>Cargando ubicación inicial...</Text>
        </View>
      )
    ) : (
      <View style={styles.centered}>
        <Text style={styles.centeredText}>
          El mapa nativo no corre en web. Probalo en Expo Go.
        </Text>
      </View>
    )}

    {/* BOTÓN DE MENÚ ARRIBA A LA DERECHA */}
    <View style={styles.topMenuContainer}>
      <TouchableOpacity
        style={styles.menuButton}
        onPress={() => setShowMenu((prev) => !prev)}
        activeOpacity={0.8}
      >
        <Text style={styles.menuIcon}>☰</Text>
      </TouchableOpacity>

      {showMenu && (
        <View style={styles.dropdownMenu}>
          <TouchableOpacity
            style={styles.dropdownItem}
            onPress={() => {
              openViewerInBrowser();
              setShowMenu(false);
            }}
          >
            <Text style={styles.dropdownText}>Visor web (solo admin)</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.dropdownItem}
            onPress={() => {
              copyViewerUrl();
              setShowMenu(false);
            }}
          >
            <Text style={styles.dropdownText}>Copiar URL (solo admin)</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.dropdownItem}
            onPress={() => {
              showSavedSessions();
              setShowMenu(false);
            }}
          >
            <Text style={styles.dropdownText}>Sesiones guardadas</Text>
          </TouchableOpacity>

          {/* 👇 NUEVO: compartir por mail */}
          <TouchableOpacity
            style={styles.dropdownItem}
            onPress={() => {
              shareCurrentLocationByEmail();
              setShowMenu(false);
            }}
          >
            <Text style={styles.dropdownText}>Compartir ubicación por mail</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>

    {/* MÉTRICAS FLOTANDO SOBRE EL MAPA (fuera del panel) */}
    <View style={styles.metricsFloating}>
      <View style={styles.metricCard}>
        <Text style={styles.metricLabel}>Tiempo</Text>
        <Text style={styles.metricValue}>{formatDuration(elapsedSec)}</Text>
        <Text style={styles.metricSmall}>sesión</Text>
      </View>

      <View style={styles.metricCard}>
        <Text style={styles.metricLabel}>Distancia</Text>
        <Text style={styles.metricValue}>
          {formatDistance(session.distance)}
        </Text>
        <Text style={styles.metricSmall}>total</Text>
      </View>

      <View style={styles.metricCard}>
        <Text style={styles.metricLabel}>Velocidad actual</Text>
        <Text style={styles.metricValue}>
          {toKmh(currentSpeed)} km/h
        </Text>
      </View>

      <View style={styles.metricCard}>
        <Text style={styles.metricLabel}>Velocidad prom.</Text>
        <Text style={styles.metricValue}>
          {toKmh(session.avgSpeed)} km/h
        </Text>
        <Text style={styles.metricSmall}>últimos puntos</Text>
      </View>
    </View>

    {/* PANEL DE ABAJO */}
    <View style={styles.bottomSheet}>
      <View style={styles.sheetHeader}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.sheetTitle}>
              {tracking ? "Seguimiento activo" : "Listo para correr"}
            </Text>
            <Text style={styles.sheetSubtitle}>
              {tracking
                ? "Enviando posición al servidor"
                : "Tocá el botón para comenzar"}
            </Text>
          </View>

          {/* Botón guardar recorrido — chico y a la derecha */}
          <TouchableOpacity
            style={
              session.points && session.points.length > 0
                ? styles.saveButton
                : [styles.saveButton, styles.saveButtonDisabled]
            }
            onPress={saveSessionToDevice}
            disabled={!session.points || session.points.length === 0}
            activeOpacity={0.8}
          >
            <Text
              style={
                session.points && session.points.length > 0
                  ? styles.saveButtonText
                  : [styles.saveButtonText, styles.saveButtonTextDisabled]
              }
            >
            Guardar recorrido
            </Text>
          </TouchableOpacity>
        </View>

        {/* Coordenadas debajo */}
        {myCoord && (
          <Text style={styles.coordText}>
            Lat: {myCoord.latitude.toFixed(6)} | Lon: {myCoord.longitude.toFixed(6)}
          </Text>
        )}
      </View>
      {/* Botón principal */}
      <View style={styles.mainButtonWrapper}>
        <View style={styles.mainButtonShadow}>
          <Button
            title={tracking ? "Detener" : "Iniciar seguimiento"}
            onPress={tracking ? stopTracking : startTracking}
            color={
              Platform.OS === "ios"
                ? undefined
                : tracking
                ? "#DC2626"
                : "#22C55E"
            }
          />
        </View>
      </View>
    </View>

    {/* MODAL: Sesiones guardadas */}
    <Modal
      visible={sessionsModalVisible}
      animationType="slide"
      transparent
      onRequestClose={() => setSessionsModalVisible(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Sesiones guardadas</Text>
            <TouchableOpacity onPress={() => setSessionsModalVisible(false)}>
              <Text style={styles.modalClose}>×</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalBody}>
            {savedSessions.map((s, index) => {
              const d = new Date(s.at);
              const dateStr = d.toLocaleString();
              const distKm = (s.distance / 1000).toFixed(2);

              // duración y pace
              let durationStr = "—";
              let paceStr = "—";
              if (s.points && s.points.length > 1) {
                const start = s.points[0].ts;
                const end = s.points[s.points.length - 1].ts;
                const durSec = Math.max(0, (end - start) / 1000);
                durationStr = formatDuration(durSec);

                if (s.distance > 0) {
                  const minTotal = durSec / 60;
                  const pace = minTotal / (s.distance / 1000);
                  const paceMin = Math.floor(pace);
                  const paceSec = Math.round((pace - paceMin) * 60);
                  paceStr =
                    paceMin.toString().padStart(2, "0") +
                    ":" +
                    paceSec.toString().padStart(2, "0") +
                    " min/km";
                }
              }

              return (
                <View key={index} style={styles.sessionCard}>
                  <Text style={styles.sessionCardTitle}>
                    {index + 1}. {dateStr}
                  </Text>
                  <Text style={styles.sessionCardLine}>
                    Distancia:{" "}
                    <Text style={styles.sessionCardBold}>{distKm} km</Text>
                  </Text>
                  <Text style={styles.sessionCardLine}>
                    Duración:{" "}
                    <Text style={styles.sessionCardBold}>{durationStr}</Text>
                  </Text>
                  <Text style={styles.sessionCardLine}>
                    Ritmo: <Text style={styles.sessionCardBold}>{paceStr}</Text>
                  </Text>
                </View>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  </View>
);

}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0F172A",
  },
  map: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0F172A",
  },
  centeredText: {
    color: "#fff",
  },

  // PANEL DE ABAJO
  bottomSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(248,249,252,0.97)",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: Platform.OS === "ios" ? 28 : 16,
    gap: 12,
  },
  sheetHeader: {
    marginBottom: 4,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#0F172A",
  },
  sheetSubtitle: {
    fontSize: 12,
    color: "rgba(15,23,42,0.6)",
    marginTop: 2,
  },
  mainButtonWrapper: {
    marginTop: 6,
  },
  mainButtonShadow: {
    borderRadius: 999,
    overflow: "hidden",
    elevation: 2,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },

  saveButton: {
    width: 130,
    height: 38,
    borderRadius: 18,
    backgroundColor: "rgba(15,23,42,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  saveButtonDisabled: {
    backgroundColor: "rgba(15,23,42,0.04)",
  },
  saveButtonText: {
    color: "#0F172A",
    fontWeight: "700",
    fontSize: 14,
  },
  saveButtonTextDisabled: {
    color: "rgba(15,23,42,0.3)",
  },

  // MÉTRICAS FLOTANTES SOBRE EL MAPA (las 4)
  metricsFloating: {
    position: "absolute",
    bottom: 155,
    left: 13,
    right: 13,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
  },
  metricCard: {
    flex: 1,
    minWidth: 140,
    backgroundColor: "rgba(15,23,42,0.85)",
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  metricLabel: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 11,
  },
  metricValue: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    marginTop: 4,
  },
  metricSmall: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 10,
    marginTop: 4,
  },

  // MENÚ ARRIBA A LA DERECHA
  topMenuContainer: {
    position: "absolute",
    top: Platform.OS === "ios" ? 52 : 32,
    right: 16,
    zIndex: 50,
    alignItems: "flex-end",
  },
  menuButton: {
    width: 44,
    height: 44,
    backgroundColor: "rgba(15,23,42,0.9)",
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  menuIcon: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "600",
  },
  dropdownMenu: {
    marginTop: 8,
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 6,
    width: 180,
    borderWidth: 1,
    borderColor: "rgba(15,23,42,0.1)",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: -2, height: 4 },
    elevation: 8,
  },
  dropdownItem: {
    width: "100%",
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  dropdownText: {
    fontSize: 13,
    color: "#0F172A",
  },

  // MODAL
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  modalCard: {
    maxHeight: "75%",
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#0F172A",
  },
  modalClose: {
    fontSize: 26,
    lineHeight: 26,
    paddingHorizontal: 6,
    color: "#0F172A",
  },
  modalBody: {
    maxHeight: "100%",
  },
  sessionCard: {
    backgroundColor: "rgba(15,23,42,0.03)",
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  sessionCardTitle: {
    fontWeight: "600",
    color: "#0F172A",
  },
  sessionCardLine: {
    fontSize: 12,
    color: "rgba(15,23,42,0.7)",
    marginTop: 4,
  },
  sessionCardBold: {
    fontWeight: "600",
    color: "#0F172A",
  },
  coordText: {
    fontSize: 12,
    color: "rgba(15,23,42,0.5)",
    marginTop: 2,
  },

});
