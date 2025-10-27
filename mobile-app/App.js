// App.js
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Device from "expo-device";
import * as Location from "expo-location";
import { useEffect, useRef, useState } from "react";
import { Button, Platform, StyleSheet, Text, View, Alert } from "react-native";
import 'react-native-get-random-values';
import MapView, { Marker, Polyline } from "react-native-maps";
import { io } from "socket.io-client";
import { v4 as uuidv4 } from "uuid";

const discoveryUrl = "https://gist.githubusercontent.com/Pabloamedey/123f37bd1e8b7b1612f2f567d5cf0e49/raw/current-tunnel.json";

// Comprobar si el dispositivo se mueve o no
const minMoveMeters = 7;     // umbral de movimiento
const masStaleSeconds = 30;  // manda un heartbeat como máximo cada 30s
const minSpeedMs = 0.5;      // quieto si va < 0.5 m/s
//maxAcceptableAcc
// calidad mínima de la muestra y confirmación de movimiento
const maxAcceptableAcc = 25; // precisión máx (en m) para considerar la muestra
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
  const [userId, setUserId] = useState("anon"); // ID persistente legible (nombre-dispositivo + uuid corto)
  const [tracking, setTracking] = useState(false);
  const [myCoord, setMyCoord] = useState(null);
  const [targetCoord, setTargetCoord] = useState(null);
  const [path, setPath] = useState([]);
  const [initialRegion, setInitialRegion] = useState(null);
  const mapRef = useRef(null);
  const socketRef = useRef(null);
  const watchRef = useRef(null); 
  const lastSentRef = useRef({ coord: null, ts: 0 });
  const moveConfirmRef = useRef(0);
  const failCountRef = useRef(0);

  const [serverUrl, setServerUrl] = useState(null);
  const [statusMsg, setStatusMsg] = useState("Descubriendo servidor…");

  // obtiene el dominio (https://xxxxx.loclx.io) desde el Gist
  async function getDynamicServer() {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 6000); // 6s por si hay 4G
      const res = await fetch(discoveryUrl, { cache: "no-store", signal: controller.signal });
      clearTimeout(t);

      if (!res.ok) throw new Error(`status ${res.status}`);
      const j = await res.json();
      const url = j?.server;
      if (url && /^https?:\/\/.+/i.test(url)) {
        await AsyncStorage.setItem("serverUrl", url); // cache local
        setStatusMsg(`Detectado: ${url}`);
        return url;
      }
      throw new Error("JSON sin 'server'");
    } catch (e) {
      setStatusMsg(`Discovery falló: ${e.message}`);
      return null;
    }
  }

  // asegura tener serverUrl (1) discovery público -> (2) cache
  async function ensureServerUrl() {
    let url = serverUrl;
    if (url) return url;

    for (let intento = 0; intento < 3; intento++) {
      const nuevo = await getDynamicServer();
      if (nuevo) {
        await AsyncStorage.setItem("serverUrl", nuevo);
        setServerUrl(nuevo);
        return nuevo;
      }
      console.log("Reintentando discovery en 3s...");
      await new Promise(res => setTimeout(res, 3000));
    }

    Alert.alert("No se pudo obtener el dominio del servidor");
    return null;
  }

  // bootstrap del serverUrl al iniciar
  useEffect(() => {
    (async () => {
      const url = await ensureServerUrl();
      if (!url) setStatusMsg("No hay serverUrl disponible (ver Gist)");
    })();
  }, []);

  // reintento pasivo cada 30s por si cambió el subdominio
  useEffect(() => {
    const id = setInterval(async () => {
      const dyn = await getDynamicServer();
      if (dyn && dyn !== serverUrl) {
        setServerUrl(dyn);
        setStatusMsg(`Dominio actualizado: ${dyn}`);
      }
    }, 30000);
    return () => clearInterval(id);
  }, [serverUrl]);

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
    if (!serverUrl) return;
    setStatusMsg(`🧩 Conectando a ${serverUrl}…`);
    try {
      socketRef.current = io(serverUrl, { transports: ["websocket", "polling"] }); // transports
    } catch (e) {
      setStatusMsg(`Error creando socket: ${e.message}`);
      return;
    }
    socketRef.current.on("connect", () => setStatusMsg(`✅ Conectado a ${serverUrl}`));
    socketRef.current.on("connect_error", (err) => setStatusMsg(`Socket error: ${err?.message || err}`));
    socketRef.current.on("locationUpdate", ({ lat, lon }) => {
      const p = { latitude: lat, longitude: lon };
      setTargetCoord(p);
      setPath((prev) => [...prev, p]);
      mapRef.current?.animateToRegion({ ...p, latitudeDelta: 0.01, longitudeDelta: 0.01 }, 600);
    });
    return () => socketRef.current?.disconnect();
  }, [serverUrl]);

  // Enviar mi ubicación con el ID persistente
  const startTracking = async () => {
    // si aún no hay serverUrl, lo buscamos ahora
    const url = await ensureServerUrl();
    if (!url) {
      Alert.alert("Sin dominio disponible", "No se pudo conectar al servidor.");
      return;
    }

    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return alert("Permiso de ubicación denegado");
    setTracking(true);

    // si había un watcher previo, limpiarlo
    if (watchRef.current) {
      try { await watchRef.current.remove(); } catch {}
      watchRef.current = null;
    }

    watchRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation, // máxima precisión
        timeInterval: 1500,        // reportes cada ~1.5s
        distanceInterval: 1,       // mínimo 1 m (nosotros filtramos más)
        mayShowUserSettingsDialog: true,
      },
      async (loc) => {
        const { latitude, longitude, speed, accuracy } = loc.coords; // speed m/s (puede venir null)
        const now = Date.now();
        const current = { latitude, longitude };

        setMyCoord(current);

        // distancia al último enviado
        const last = lastSentRef.current;
        const dist = last.coord ? haversine(last.coord, current) : Infinity;
        const elapsed = (now - last.ts) / 1000;

        // descartar muestras muy imprecisas, salvo que toque heartbeat
        const heartbeatDue = elapsed >= masStaleSeconds;  

        if (accuracy != null && accuracy > maxAcceptableAcc && !heartbeatDue) {
          // muestra muy ruidosa: la ignoramos sin resetear nada
          return;
        }

        const stillBySpeed = (typeof speed === "number" ? speed : 0) < minSpeedMs;
        const movedByDistance = dist >= minMoveMeters;

        // confirmación por consecutivas
        if (movedByDistance && !stillBySpeed) {
          moveConfirmRef.current += 1;
        } else {
          moveConfirmRef.current = 0;
        }

        // ¿enviar ahora?
        const movementConfirmed = moveConfirmRef.current >= consecConfirm;
        const shouldSend = movementConfirmed || heartbeatDue;

        // si estoy quieto y aún no toca heartbeat, no enviar
        if (!shouldSend) {
          if (dist > 3) {
            mapRef.current?.animateToRegion(
              { ...current, latitudeDelta: 0.01, longitudeDelta: 0.01 },
              400
            );
          }
          return;
        }

        // enviar (por movimiento real o heartbeat)
        try {
            await fetch(`${url}/location`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                userId,
                lat: latitude,
                lon: longitude,
                ts: now,
              }),
            });

            // si enviamos por movimiento, reseteamos el contador
            if (movementConfirmed) moveConfirmRef.current = 0;

            lastSentRef.current = { coord: current, ts: now };
            failCountRef.current = 0; // OK -> reseteo contador

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
    // limpiar el watcher si existe
    if (watchRef.current) {
      try {
        await watchRef.current.remove();
      } catch {}
      watchRef.current = null;
    }
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
