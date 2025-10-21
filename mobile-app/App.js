// App.js
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Device from "expo-device";
import * as Location from "expo-location";
import { useEffect, useRef, useState } from "react";
import { Button, Platform, StyleSheet, Text, View } from "react-native";
import 'react-native-get-random-values';
import MapView, { Marker, Polyline } from "react-native-maps";
import { io } from "socket.io-client";
import { v4 as uuidv4 } from "uuid";

const SERVER_URL = "http://nv7rcq6fmp.loclx.io";

// Comprobar si el dispositivo se mueve o no
const MIN_MOVE_METERS = 7;     // umbral de movimiento
const MAX_STALE_SECONDS = 30;  // manda un heartbeat como máximo cada 30s
const MIN_SPEED_MS = 0.3;      // quieto si va < 0.3 m/s

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
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      });
    })();
  }, []);

  // Socket para ver al “seguido” en tiempo real
  useEffect(() => {
    socketRef.current = io(SERVER_URL);
    socketRef.current.on("locationUpdate", ({ lat, lon }) => {
      const p = { latitude: lat, longitude: lon };
      setTargetCoord(p);
      setPath((prev) => [...prev, p]);
      mapRef.current?.animateToRegion({ ...p, latitudeDelta: 0.01, longitudeDelta: 0.01 }, 600);
    });
    return () => socketRef.current?.disconnect();
  }, []);

  // Enviar mi ubicación con el ID persistente
  const startTracking = async () => {
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
      timeInterval: 2000,        // reportes cada ~2s
      distanceInterval: 1,       // mínimo 1 m (nosotros filtramos más)
      mayShowUserSettingsDialog: true,
    },
    async (loc) => {
      const { latitude, longitude, speed } = loc.coords; // speed m/s (puede venir null)
      const now = Date.now();
      const current = { latitude, longitude };

      setMyCoord(current);

      // distancia al último enviado
      const last = lastSentRef.current;
      const dist = last.coord ? haversine(last.coord, current) : Infinity;
      const elapsed = (now - last.ts) / 1000;

      const seemsStill = (speed != null ? speed < MIN_SPEED_MS : true) && dist < MIN_MOVE_METERS;
      const allowHeartbeat = elapsed > MAX_STALE_SECONDS;

      // si estoy quieto y aún no toca heartbeat, no enviar
      if (seemsStill && !allowHeartbeat) {
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
        await fetch(`${SERVER_URL}/location`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            lat: latitude,
            lon: longitude,
            ts: now,
          }),
        });
        lastSentRef.current = { coord: current, ts: now };

        if (dist > MIN_MOVE_METERS) {
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
