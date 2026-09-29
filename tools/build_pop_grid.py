#!/usr/bin/env python3
"""
Build public/data/pop_grid.json from a WorldPop (or Meta HRSL) population GeoTIFF.

1. Download Myanmar population raster (free):
     WorldPop → https://hub.worldpop.org/  → Population Counts → Myanmar (MMR) → 100m, latest year
     (file looks like  mmr_ppp_2020_constrained.tif  or  mmr_pop_2025_CN_100m_R2025A_v1.tif)
2. pip install rasterio numpy
3. python tools/build_pop_grid.py mmr_ppp_2020_constrained.tif --year 2020

By default only the main cities are kept (keeps the file small enough for the browser).
Add areas with --bbox "name:south,west,north,east".  --all keeps the whole country
(~several MB at 500 m cells — use --cell 1000 for that).
"""
import argparse, json, math, pathlib
import numpy as np
import rasterio
from rasterio.windows import from_bounds

CITIES = {
    "Yangon":    (16.62, 95.95, 17.10, 96.40),
    "Mandalay":  (21.82, 95.98, 22.10, 96.20),
    "Naypyitaw": (19.55, 96.00, 19.95, 96.30),
    "Bago":      (17.25, 96.40, 17.40, 96.55),
    "Mawlamyine":(16.40, 97.58, 16.55, 97.68),
    "Taunggyi":  (20.72, 96.98, 20.84, 97.08),
    "Pathein":   (16.73, 94.68, 16.83, 94.78),
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tif")
    ap.add_argument("--year", default="")
    ap.add_argument("--source", default="WorldPop")
    ap.add_argument("--cell", type=int, default=250, help="output cell size in metres (default 250)")
    ap.add_argument("--bbox", action="append", default=[], help='extra area "name:south,west,north,east"')
    ap.add_argument("--all", action="store_true", help="whole raster instead of city boxes")
    ap.add_argument("--out", default=str(pathlib.Path(__file__).resolve().parent.parent / "public/data/pop_grid.json"))
    a = ap.parse_args()

    areas = {} if a.all else dict(CITIES)
    for b in a.bbox:
        name, nums = b.split(":")
        areas[name] = tuple(float(x) for x in nums.split(","))

    points, total = [], 0.0
    with rasterio.open(a.tif) as src:
        if src.crs and src.crs.to_epsg() != 4326:
            raise SystemExit("Raster must be in EPSG:4326 (WorldPop/HRSL already are).")
        res_deg = abs(src.transform.a)
        mid_lat = 20.0
        factor = max(1, round(a.cell / (res_deg * 111320 * math.cos(math.radians(mid_lat)))))
        b = src.bounds
        boxes = [(b.left, b.bottom, b.right, b.top)] if a.all else [(w, s, e, n) for (s, w, n, e) in areas.values()]
        for (w, s, e, n) in boxes:
            win = from_bounds(w, s, e, n, src.transform).round_offsets().round_lengths()
            arr = src.read(1, window=win, boundless=True, fill_value=0).astype("float64")
            nod = src.nodata
            if nod is not None: arr[arr == nod] = 0
            arr[~np.isfinite(arr) | (arr < 0)] = 0
            h, wd = (arr.shape[0] // factor) * factor, (arr.shape[1] // factor) * factor
            agg = arr[:h, :wd].reshape(h // factor, factor, wd // factor, factor).sum(axis=(1, 3))
            t = src.window_transform(win)
            for i, j in zip(*np.nonzero(agg >= 1)):
                lng = t.c + (j * factor + factor / 2) * t.a
                lat = t.f + (i * factor + factor / 2) * t.e
                v = float(agg[i, j]); total += v
                points.append([round(lat, 5), round(lng, 5), round(v)])

    out = {"source": a.source, "year": a.year, "cellDeg": res_deg * factor, "cellM": a.cell,
           "areas": list(areas) or ["all"], "points": points}
    pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(a.out).write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(points):,} cells, {total:,.0f} people → {a.out} ({pathlib.Path(a.out).stat().st_size/1e6:.1f} MB)")

if __name__ == "__main__":
    main()
