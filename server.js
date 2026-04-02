/**
 * Hop Price Server - Servidor de precios VTC
 * Usa OSRM para rutas reales + tarifas calibradas por proveedor
 * Ligero, sin Playwright, funciona en Render Free (512MB)
 *
 * GET /api/prices?olat=40.416&olng=-3.703&dlat=40.493&dlng=-3.566
 * GET /api/health
 */

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// CACHE
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCacheKey(olat, olng, dlat, dlng) {
  return olat.toFixed(3) + "," + olng.toFixed(3) + "-" + dlat.toFixed(3) + "," + dlng.toFixed(3);
}

// OSRM - Ruta real de conduccion
async function getRoute(olat, olng, dlat, dlng) {
  try {
    const url = "https://router.project-osrm.org/route/v1/driving/" + olng + "," + olat + ";" + dlng + "," + dlat + "?overview=false";
    const res = await fetch(url);
    const data = await res.json();
    if (data && data.routes && data.routes[0]) {
      return {
        distKm: Math.round((data.routes[0].distance / 1000) * 10) / 10,
        durMin: Math.round(data.routes[0].duration / 60),
      };
    }
  } catch (e) {
    console.error("OSRM error:", e.message);
  }
  return null;
}

// TARIFAS calibradas Madrid 2024-2025
const TARIFFS = {
  uber:   { name: "Uber",   service: "UberX",      base: 1.15, perKm: 0.94, perMin: 0.13, minFare: 4.0,  fee: 0.75 },
  bolt:   { name: "Bolt",   service: "Bolt Lite",   base: 0.99, perKm: 0.84, perMin: 0.12, minFare: 3.5,  fee: 0.49 },
  cabify: { name: "Cabify", service: "Cabify Lite", base: 1.35, perKm: 1.05, perMin: 0.15, minFare: 5.0,  fee: 0.00 },
};

function getSurge(id) {
  const h = new Date().getHours();
  let s = 1.0;
  if (h >= 7 && h <= 9)        s = 1.12;
  else if (h >= 12 && h <= 14) s = 1.06;
  else if (h >= 17 && h <= 20) s = 1.18;
  else if (h >= 22 || h <= 2)  s = 1.25;
  else if (h >= 3 && h <= 6)   s = 1.10;

  if (id === "bolt")  s = 1.0 + (s - 1.0) * 0.7;
  if (id === "uber")  s = 1.0 + (s - 1.0) * 1.1;
  return s;
}

function estimatePrice(id, distKm, durMin) {
  const t = TARIFFS[id];
  const surge = getSurge(id);
  let raw = (t.base + t.perKm * distKm + t.perMin * durMin + t.fee) * surge;
  const v = id === "cabify" ? 0.04 : id === "bolt" ? 0.05 : 0.06;
  raw *= 1.0 + (Math.random() * 2 - 1) * v;
  return Math.round(Math.max(raw, t.minFare) * 100) / 100;
}

function estimateEta(id) {
  if (id === "bolt")   return Math.floor(2 + Math.random() * 4);
  if (id === "cabify") return Math.floor(4 + Math.random() * 6);
  return Math.floor(3 + Math.random() * 5);
}

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ENDPOINTS
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "hop-price-server", cache_size: cache.size });
});

app.get("/api/prices", async (req, res) => {
  const olat = parseFloat(req.query.olat);
  const olng = parseFloat(req.query.olng);
  const dlat = parseFloat(req.query.dlat);
  const dlng = parseFloat(req.query.dlng);

  if (isNaN(olat) || isNaN(olng) || isNaN(dlat) || isNaN(dlng)) {
    return res.status(400).json({ error: "Params: olat, olng, dlat, dlng" });
  }

  const key = getCacheKey(olat, olng, dlat, dlng);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  const route = await getRoute(olat, olng, dlat, dlng);
  if (!route) {
    return res.status(500).json({ error: "No se pudo calcular la ruta" });
  }

  const providers = ["uber", "bolt", "cabify"].map((id) => ({
    id,
    name: TARIFFS[id].name,
    service: TARIFFS[id].service,
    price: estimatePrice(id, route.distKm, route.durMin),
    eta: estimateEta(id),
    source: "server_estimate",
  })).sort((a, b) => a.price - b.price);

  const response = {
    providers,
    route: { distance_km: route.distKm, duration_min: route.durMin },
    timestamp: Math.floor(Date.now() / 1000),
  };

  cache.set(key, { data: response, ts: Date.now() });

  for (const [k, v] of cache) {
    if (Date.now() - v.ts > CACHE_TTL) cache.delete(k);
  }

  res.json(response);
});

app.listen(PORT, () => {
  console.log("Hop Price Server running on port " + PORT);
});
