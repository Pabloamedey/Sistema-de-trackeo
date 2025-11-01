// App.js
// import * as Sharing from "expo-sharing";
//import * as IntentLauncher from "expo-intent-launcher"; // Android
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as FileSystem from "expo-file-system/legacy";
import * as Location from "expo-location";
import * as MediaLibrary from "expo-media-library";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Linking, Platform, StyleSheet, Text, View } from "react-native";
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

      // mostramos las últimas 3 nomás para no hacer un choclo
      const last3 = arr.slice(-3).reverse();
      const msg = last3
        .map((s, i) => {
          const dKm = (s.distance / 1000).toFixed(2);
          return `${i + 1}. ${s.at} — ${dKm} km`;
        })
        .join("\n");

      Alert.alert("Sesiones guardadas", msg);
    } catch (e) {
      Alert.alert("Error", "No pude leer las sesiones: " + e.message);
    }
  };

  const toKmh = (ms) => (ms * 3.6).toFixed(1);
  const formatDistance = (m) => {
    if (!m || m <= 0) return "0.00 km";
    return `${(m / 1000).toFixed(2)} km`;
  };

  
  return (
    <View style={{ flex: 1 }}>
      {Platform.OS !== "web" ? (
        initialRegion ? (
          <MapView ref={mapRef} style={{ flex: 1 }} initialRegion={initialRegion}>
            {myCoord && <Marker coordinate={myCoord} title={`📱 ${userId}`} pinColor="blue" />}
            {targetCoord && <Marker coordinate={targetCoord} title="📍 Tracker seguido" />}
            {path.length > 1 && <Polyline coordinates={path} />}
          </MapView>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Text>Cargando ubicación inicial...</Text>
          </View>
        )
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text>El mapa nativo no corre en web. Probalo en Expo Go.</Text>
        </View>
      )}

      <View style={styles.controls}>
        <Button
          title={tracking ? "Detener" : "Iniciar seguimiento"}
          onPress={tracking ? stopTracking : startTracking}
        />
        <Text style={styles.info}>
          ID: {userId}
          {"\n"}
          Yo:{" "}
          {myCoord
            ? `${myCoord.latitude.toFixed(5)}, ${myCoord.longitude.toFixed(5)}`
            : "—"}
        </Text>
        <View style={{ marginTop: 8, gap: 8 }}>
          <Button title="Abrir visor web" onPress={openViewerInBrowser} />
          <Button title="Copiar URL del visor" onPress={copyViewerUrl} />
        </View>
        <Text style={styles.info}>
          Distancia sesión: {formatDistance(session.distance)}{"\n"}
          Vel. actual: {toKmh(currentSpeed)} km/h{"\n"}
          Vel. promedio: {toKmh(session.avgSpeed)} km/h{"\n"}
        </Text>
        <Button title="Guardar recorrido" onPress={saveSessionToDevice} />
        <Button title="Ver sesiones guardadas" onPress={showSavedSessions} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  controls: {
    position: "absolute",
    bottom: 16,
    left: 16,
    right: 16,
    backgroundColor: "rgba(255,255,255,0.9)",
    padding: 12,
    borderRadius: 12,
  },
  info: { marginTop: 8, fontSize: 12 },
});