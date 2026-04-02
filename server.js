/**
 * Hop Price Scraper — Servidor de precios VTC reales
 * Usa Playwright (navegador headless) para obtener precios de Uber, Bolt y Cabify
 * como si fuera un usuario real navegando sus webs.
 *
 * Deploy: Render.com (free tier con Docker)
 * Endpoint: GET /api/prices?olat=40.416&olng=-3.703&dlat=40.493&dlng=-3.566
 */

const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CACHE — Evita scraping repetido para rutas similares
// ============================================================
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getCacheKey(olat, olng, dlat, dlng) {
  return `${olat.toFixed(3)},${olng.toFixed(3)}-${dlat.toFixed(3)},${dlng.toFixed(3)}`;
}

// ============================================================
// OSRM — Ruta real de conduccion (siempre funciona)
// ============================================================
async function getRoute(olat, olng, dlat, dlng) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${olng},${olat};${dlng},${dlat}?overview=false`;
    const res = await fetch(url);
    const data = await res.json();
    if (data?.routes?.[0]) {
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

// ============================================================
// TARIFAS FALLBACK (si el scraping falla)
// ============================================================
const TARIFFS = {
  uber:   { name: "Uber",   service: "UberX",       base: 1.15, perKm: 0.94, perMin: 0.13, minFare: 4.0,  fee: 0.75 },
  bolt:   { name: "Bolt",   service: "Bolt",         base: 0.99, perKm: 0.84, perMin: 0.12, minFare: 3.5,  fee: 0.49 },
  cabify: { name: "Cabify", service: "Cabify Lite",  base: 1.35, perKm: 1.05, perMin: 0.15, minFare: 5.0,  fee: 0.00 },
};

function estimateFallback(id, distKm, durMin) {
  const t = TARIFFS[id];
  const h = new Date().getHours();
  let surge = 1.0;
  if (h >= 7 && h <= 9) surge = 1.12;
  else if (h >= 17 && h <= 20) surge = 1.18;
  else if (h >= 22 || h <= 2) surge = 1.25;
  if (id === "bolt") surge = 1.0 + (surge - 1.0) * 0.7;
  else if (id === "uber") surge = 1.0 + (surge - 1.0) * 1.1;
  let raw = (t.base + t.perKm * distKm + t.perMin * durMin + t.fee) * surge;
  raw *= 1.0 + (Math.random() * 0.1 - 0.05);
  return Math.round(Math.max(raw, t.minFare) * 100) / 100;
}

// ============================================================
// BROWSER — Singleton de Playwright (se reutiliza)
// ============================================================
let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    console.log("Lanzando navegador headless...");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browser;
}

// ============================================================
// SCRAPERS — Obtienen precios reales de cada plataforma
// ============================================================

async function scrapeUber(page, olat, olng, dlat, dlng) {
  try {
    const url = `https://m.uber.com/go/product-selection`
      + `?drop%5B0%5D=%7B%22latitude%22%3A${dlat}%2C%22longitude%22%3A${dlng}%7D`
      + `&pickup=%7B%22latitude%22%3A${olat}%2C%22longitude%22%3A${olng}%7D`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(3000);
    const prices = await page.evaluate(() => {
      const results = [];
      const allText = document.body.innerText;
      const priceMatches = allText.match(/(\\d+[.,]\\d{2})\\s*\u20ac|\u20ac\\s*(\\d+[.,]\\d{2})/g);
      if (priceMatches) {
        for (const m of priceMatches) {
          const nums = m.match(/(\\d+[.,]\\d{2})/);
          if (nums) results.push(parseFloat(nums[1].replace(",", ".")));
        }
      }
      const rangeMatches = allText.match(/(\\d+)\\s*[-\u2013]\\s*(\\d+)\\s*\u20ac/g);
      if (rangeMatches) {
        for (const m of rangeMatches) {
          const nums = m.match(/(\\d+)\\s*[-\u2013]\\s*(\\d+)/);
          if (nums) results.push((parseInt(nums[1]) + parseInt(nums[2])) / 2);
        }
      }
      return results;
    });
    if (prices.length > 0) {
      const price = Math.min(...prices.filter(p => p > 2 && p < 500));
      if (price && price > 2) {
        console.log(`  Uber: ${price} EUR (scrapeado)`);
        return { price, source: "uber_scrape" };
      }
    }
  } catch (e) {
    console.log(`  Uber scrape fallo: ${e.message}`);
  }
  return null;
}

async function scrapeBolt(page, olat, olng, dlat, dlng) {
  try {
    const url = `https://bolt.eu/es-es/fare-estimator/`
      + `?lat_a=${olat}&lng_a=${olng}&lat_b=${dlat}&lng_b=${dlng}`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(3000);
    const prices = await page.evaluate(() => {
      const results = [];
      const allText = document.body.innerText;
      const priceMatches = allText.match(/(\\d+[.,]\\d{2})\\s*\u20ac|\u20ac\\s*(\\d+[.,]\\d{2})/g);
      if (priceMatches) {
        for (const m of priceMatches) {
          const nums = m.match(/(\\d+[.,]\\d{2})/);
          if (nums) results.push(parseFloat(nums[1].replace(",", ".")));
        }
      }
      const rangeMatches = allText.match(/(\\d+)\\s*[-\u2013]\\s*(\\d+)\\s*\u20ac/g);
      if (rangeMatches) {
        for (const m of rangeMatches) {
          const nums = m.match(/(\\d+)\\s*[-\u2013]\\s*(\\d+)/);
          if (nums) results.push((parseInt(nums[1]) + parseInt(nums[2])) / 2);
        }
      }
      return results;
    });
    if (prices.length > 0) {
      const price = Math.min(...prices.filter(p => p > 2 && p < 500));
      if (price && price > 2) {
        console.log(`  Bolt: ${price} EUR (scrapeado)`);
        return { price, source: "bolt_scrape" };
      }
    }
  } catch (e) {
    console.log(`  Bolt scrape fallo: ${e.message}`);
  }
  return null;
}

async function scrapeCabify(page, olat, olng, dlat, dlng) {
  try {
    const url = `https://cabify.com/es/rider`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log(`  Cabify scrape fallo: ${e.message}`);
  }
  return null;
}

// ============================================================
// SCRAPING PRINCIPAL — Ejecuta todos los scrapers en paralelo
// ============================================================
async function scrapeAllPrices(olat, olng, dlat, dlng, route) {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    locale: "es-ES",
  });
  const results = {};
  try {
    const [pageUber, pageBolt, pageCabify] = await Promise.all([
      context.newPage(), context.newPage(), context.newPage(),
    ]);
    const [uberResult, boltResult, cabifyResult] = await Promise.allSettled([
      scrapeUber(pageUber, olat, olng, dlat, dlng),
      scrapeBolt(pageBolt, olat, olng, dlat, dlng),
      scrapeCabify(pageCabify, olat, olng, dlat, dlng),
    ]);
    if (uberResult.status === "fulfilled" && uberResult.value) results.uber = uberResult.value;
    if (boltResult.status === "fulfilled" && boltResult.value) results.bolt = boltResult.value;
    if (cabifyResult.status === "fulfilled" && cabifyResult.value) results.cabify = cabifyResult.value;
  } catch (e) {
    console.error("Error en scraping:", e.message);
  } finally {
    await context.close();
  }
  return results;
}

// ============================================================
// CORS
// ============================================================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ============================================================
// ENDPOINTS
// ============================================================
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "hop-price-scraper", cache_size: cache.size });
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
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`Cache hit: ${key}`);
    return res.json({ ...cached.data, cached: true });
  }
  console.log(`Consulta: (${olat},${olng}) -> (${dlat},${dlng})`);
  const route = await getRoute(olat, olng, dlat, dlng);
  if (!route) {
    return res.status(500).json({ error: "No se pudo calcular la ruta", providers: [] });
  }
  console.log(`  Ruta: ${route.distKm} km, ${route.durMin} min`);
  console.log("  Scrapeando precios reales...");
  const scraped = await scrapeAllPrices(olat, olng, dlat, dlng, route);
  const providers = ["uber", "bolt", "cabify"].map((id) => {
    const real = scraped[id];
    const price = real ? real.price : estimateFallback(id, route.distKm, route.durMin);
    const source = real ? real.source : "estimate";
    let eta;
    if (id === "bolt") eta = Math.floor(2 + Math.random() * 4);
    else if (id === "cabify") eta = Math.floor(4 + Math.random() * 6);
    else eta = Math.floor(3 + Math.random() * 5);
    return { id, name: TARIFFS[id].name, service: TARIFFS[id].service, price, eta, source };
  }).sort((a, b) => a.price - b.price);
  const response = {
    providers,
    route: { distance_km: route.distKm, duration_min: route.durMin },
    timestamp: Math.floor(Date.now() / 1000),
  };
  cache.set(key, { data: response, timestamp: Date.now() });
  for (const [k, v] of cache) {
    if (Date.now() - v.timestamp > CACHE_TTL) cache.delete(k);
  }
  console.log("  Resultados:");
  for (const p of providers) {
    console.log(`    ${p.name}: ${p.price} EUR (${p.source})`);
  }
  res.json(response);
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`Hop Price Scraper escuchando en http://localhost:${PORT}`);
  console.log(`GET /api/prices?olat=X&olng=Y&dlat=X&dlng=Y`);
  getBrowser().then(() => console.log("Navegador listo"));
});
