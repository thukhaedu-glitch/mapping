// Base map tile provider — chosen in firebase-config.js (mapTiles).
//   "osm"      : OpenStreetMap standard tiles. Free, no key. Fine for internal/low traffic;
//                OSM's usage policy does NOT allow heavy commercial use → use MapTiler for SaaS.
//   "maptiler" : MapTiler Streets. Free key (100k tiles/month) at https://cloud.maptiler.com
//   "carto"    : CARTO Voyager. Now needs an API key/allow-listed domain.
import { mapTiles } from "./firebase-config.js";

const cfg = mapTiles || {};
const provider = cfg.provider || (cfg.maptilerKey ? "maptiler" : "osm");

const PROVIDERS = {
  osm: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19,
    html: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    text: "© OpenStreetMap contributors",
    maxConnections: 2, maxExport: 3000,   // OSM tile policy: max 2 parallel downloads, no bulk fetching
  },
  maptiler: {
    url: `https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=${encodeURIComponent(cfg.maptilerKey || "")}`, maxZoom: 20,
    html: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    text: "© MapTiler © OpenStreetMap contributors",
  },
  carto: {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", subdomains: "abcd", maxZoom: 19,
    html: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    text: "© OpenStreetMap contributors © CARTO",
  },
};

export const TILES = PROVIDERS[provider] || PROVIDERS.osm;
export const TILE_PROVIDER = PROVIDERS[provider] ? provider : "osm";

/** Concrete URL for one tile (used by the high-res export). */
export function tileUrl(z, x, y) {
  const s = TILES.subdomains ? TILES.subdomains[(x + y) % TILES.subdomains.length] : "";
  return TILES.url.replace("{s}", s).replace("{z}", z).replace("{x}", x).replace("{y}", y);
}
