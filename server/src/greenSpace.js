import { fromCustomClient } from 'geotiff';

const R = 6371008.8;
const rad = Math.PI / 180;
export const GREEN_RADIUS_M = 300;
const labels = { 10: 'tree_cover', 20: 'shrubland', 30: 'grassland', 40: 'cropland', 50: 'built_up', 60: 'bare_sparse', 70: 'snow_ice', 80: 'water', 90: 'wetland', 95: 'mangroves', 100: 'moss_lichen' };
const naturalVegetation = new Set([10, 20, 30, 90, 95, 100]);
const cache = new Map();
let active = 0;

export function greenSpacePoint(row) {
  const latitude = Number(row.double_latitude ?? row.latitude);
  const longitude = Number(row.double_longitude ?? row.longitude);
  const rawAccuracy = row.double_accuracy ?? row.accuracy;
  const accuracy = rawAccuracy === null || rawAccuracy === undefined || rawAccuracy === '' ? null : Number(rawAccuracy);
  let timestamp = Number(row.timestamp);
  if (timestamp < 1e11) timestamp *= 1000;
  const point = { latitude: Math.round(latitude * 1000) / 1000, longitude: Math.round(longitude * 1000) / 1000,
    timestamp, hour: Math.floor(timestamp / 3600000) * 3600000,
    location_accuracy_m: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null };
  point.coordinate_rounding_error_m = distance(latitude, longitude, point.latitude, point.longitude);
  point.green_space_status = Math.abs(latitude) > 85 ? 'unsupported_latitude'
    : point.location_accuracy_m === null ? 'location_accuracy_unavailable'
      : point.location_accuracy_m > 100 ? 'location_accuracy_poor' : 'eligible';
  return point;
}

function distance(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function worldCoverTile(south, west) {
  const tile = `${south < 0 ? 'S' : 'N'}${String(Math.abs(south)).padStart(2, '0')}${west < 0 ? 'W' : 'E'}${String(Math.abs(west)).padStart(3, '0')}`;
  return `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${tile}_Map.tif`;
}

export function greenSpaceRegions(point) {
  const dy = GREEN_RADIUS_M / (R * rad);
  const dx = dy / Math.cos(point.latitude * rad);
  const bounds = [point.longitude - dx, point.latitude - dy, point.longitude + dx, point.latitude + dy];
  const regions = [];
  for (let south = Math.floor(bounds[1] / 3) * 3; south < bounds[3]; south += 3) {
    for (let west = Math.floor(bounds[0] / 3) * 3; west < bounds[2]; west += 3) {
      const wrappedWest = ((west + 180) % 360 + 360) % 360 - 180;
      const shift = wrappedWest - west;
      regions.push({ south, west: wrappedWest, bounds: [Math.max(west, bounds[0]) + shift, Math.max(south, bounds[1]), Math.min(west + 3, bounds[2]) + shift, Math.min(south + 3, bounds[3])] });
    }
  }
  return regions;
}

// Reads only small HTTP byte ranges, never whole global/three-degree rasters.
// The public tile URL contains a three-degree map tile, not participant IDs or
// coordinates. The buffer calculation is performed in the Railway process.
export async function readWorldCoverRegion(region, signal) {
  const url = worldCoverTile(region.south, region.west);
  let downloaded = 0;
  let missingTile = false;
  const client = { async request({ headers, signal: localSignal }) {
    const response = await fetch(url, { headers, signal: localSignal ? AbortSignal.any([signal, localSignal]) : signal });
    if (response.status !== 206) {
      await response.body?.cancel();
      const error = new Error(`WorldCover tile HTTP ${response.status}; byte ranges required`);
      error.tileMissing = response.status === 404;
      missingTile = error.tileMissing;
      throw error;
    }
    const length = Number(response.headers.get('content-length'));
    if (!Number.isFinite(length) || length <= 0 || length > 2 * 1024 * 1024 || downloaded + length > 8 * 1024 * 1024) {
      await response.body?.cancel();
      throw new Error('WorldCover response exceeds the map-read limit');
    }
    downloaded += length;
    return { status: response.status, ok: response.ok, getHeader: name => response.headers.get(name), getData: () => response.arrayBuffer() };
  } };
  let image;
  try {
    const tiff = await fromCustomClient(client, { allowFullFile: false, blockSize: 65536, cacheSize: 8 }, signal);
    image = await tiff.getImage();
  } catch (error) {
    // A missing tile is unknown coverage, including ocean; never assume zero
    // vegetation. An unavailable edge tile makes the buffer partial.
    if (missingTile || error.tileMissing) return emptyRegion(region);
    throw error;
  }
  const bbox = image.getBoundingBox();
  const geo = image.getGeoKeys();
  if (geo.GeographicTypeGeoKey !== 4326 || bbox.some(v => !Number.isFinite(v))) throw new Error('Unexpected WorldCover coordinate system');
  const sx = (bbox[2] - bbox[0]) / image.getWidth();
  const sy = (bbox[3] - bbox[1]) / image.getHeight();
  const [left, bottom, right, top] = region.bounds;
  if (left < bbox[0] - sx / 100 || right > bbox[2] + sx / 100 || bottom < bbox[1] - sy / 100 || top > bbox[3] + sy / 100) {
    throw new Error('WorldCover tile does not cover the requested map window');
  }
  const x0 = Math.max(0, Math.floor((left - bbox[0]) / sx));
  const y0 = Math.max(0, Math.floor((bbox[3] - top) / sy));
  const x1 = Math.min(image.getWidth(), Math.ceil((right - bbox[0]) / sx));
  const y1 = Math.min(image.getHeight(), Math.ceil((bbox[3] - bottom) / sy));
  if (x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) > 100000) throw new Error('WorldCover window is invalid or too large');
  const values = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true, signal });
  return { values, width: x1 - x0, height: y1 - y0, west: bbox[0] + x0 * sx, north: bbox[3] - y0 * sy, sx, sy };
}

function emptyRegion(region) {
  const sx = 1 / 12000;
  const sy = sx;
  const [left, bottom, right, top] = region.bounds;
  const x0 = Math.floor((left - region.west) / sx);
  const y0 = Math.floor((region.south + 3 - top) / sy);
  const width = Math.ceil((right - region.west) / sx) - x0;
  const height = Math.ceil((region.south + 3 - bottom) / sy) - y0;
  return { values: new Uint8Array(width * height), width, height, west: region.west + x0 * sx, north: region.south + 3 - y0 * sy, sx, sy };
}

export function summarizeGreenSpace(point, rasters) {
  const areas = Object.fromEntries(Object.keys(labels).map(code => [code, 0]));
  let totalArea = 0;
  let validArea = 0;
  for (const raster of rasters) {
    for (let y = 0; y < raster.height; y++) {
      const lat = raster.north - (y + 0.5) * raster.sy;
      const area = R ** 2 * rad ** 2 * raster.sx * raster.sy * Math.cos(lat * rad);
      for (let x = 0; x < raster.width; x++) {
        const lon = raster.west + (x + 0.5) * raster.sx;
        if (distance(point.latitude, point.longitude, lat, lon) > GREEN_RADIUS_M) continue;
        totalArea += area;
        const code = raster.values[y * raster.width + x];
        if (!Object.hasOwn(labels, code)) continue;
        areas[code] += area;
        validArea += area;
      }
    }
  }
  const coverage = totalArea ? validArea / totalArea * 100 : 0;
  const usable = coverage >= 90 && validArea > 0;
  const percent = codes => usable ? Math.round(codes.reduce((sum, code) => sum + areas[code], 0) / validArea * 10000) / 100 : null;
  return { green_space_status: usable ? 'available' : validArea ? 'partial_map_coverage' : 'no_map_data',
    map_valid_coverage_percent: Math.round(coverage * 100) / 100,
    natural_vegetation_percent_300m: percent([...naturalVegetation]), tree_cover_percent_300m: percent([10]),
    cropland_percent_300m: percent([40]), built_up_percent_300m: percent([50]), water_percent_300m: percent([80]) };
}

export async function fetchGreenSpace(point, reader = readWorldCoverRegion) {
  const metadata = { source: 'esa_worldcover', measurement_type: 'historical_land_cover_context',
    map_dataset: 'ESA WorldCover 2021 v200', map_reference_year: 2021, map_nominal_resolution_m: 10,
    green_buffer_radius_m: GREEN_RADIUS_M, location_accuracy_m: point.location_accuracy_m,
    coordinate_rounding_error_m: Math.round(point.coordinate_rounding_error_m * 10) / 10,
    coordinate_precision_degrees: 0.001,
    attribution: '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. CC BY 4.0. https://doi.org/10.5281/zenodo.7254221' };
  if (point.green_space_status !== 'eligible') return { ...metadata, green_space_status: point.green_space_status,
    map_valid_coverage_percent: null, natural_vegetation_percent_300m: null, tree_cover_percent_300m: null,
    cropland_percent_300m: null, built_up_percent_300m: null, water_percent_300m: null };
  // Bound concurrent decoding/network jobs. A later location upload retries
  // when capacity is unavailable, without rejecting its GPS data.
  const key = `${point.latitude}|${point.longitude}`;
  let entry = cache.get(key);
  if (!entry || entry.expires <= Date.now()) {
    if (active >= 2) throw new Error('WorldCover capacity busy; retry on the next location upload');
    active++;
    const signal = AbortSignal.timeout(12000);
    const result = (async () => {
      const rasters = [];
      for (const region of greenSpaceRegions(point)) rasters.push(await reader(region, signal));
      return summarizeGreenSpace(point, rasters);
    })().finally(() => { active--; });
    entry = { result, expires: Date.now() + 86400000 };
    cache.set(key, entry);
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    result.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  }
  return { ...metadata, ...await entry.result };
}
