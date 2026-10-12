// Product names from the free Open Food Facts family of databases.
// Food first, then household and cosmetics. Returns a short German name or null.

const SOURCES = [
  "https://world.openfoodfacts.org",
  "https://world.openproductsfacts.org",
  "https://world.openbeautyfacts.org",
];
const FIELDS = "product_name_de,product_name,generic_name_de,brands,quantity";
const cache = new Map();

function withTimeout(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

export function formatName(p) {
  const name = (p.product_name_de || p.product_name || p.generic_name_de || "").trim();
  if (!name) return null;
  const brand = (p.brands || "").split(",")[0].trim();
  const qty = (p.quantity || "").trim();
  let out = brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name;
  if (qty && !out.toLowerCase().includes(qty.toLowerCase())) out += `, ${qty}`;
  return out.replace(/\s+/g, " ");
}

export async function lookupProduct(ean) {
  if (cache.has(ean)) return cache.get(ean);
  if (!navigator.onLine) return null;
  for (const base of SOURCES) {
    try {
      const r = await fetch(`${base}/api/v2/product/${encodeURIComponent(ean)}.json?fields=${FIELDS}&lc=de`, { signal: withTimeout(4000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.status === 1 && j.product) {
        const name = formatName(j.product);
        if (name) { cache.set(ean, name); return name; }
      }
    } catch { /* offline or slow: try next / give up */ }
  }
  return null;
}
