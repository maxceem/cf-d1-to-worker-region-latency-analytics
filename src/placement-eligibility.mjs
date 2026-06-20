export function getMinSuccessfulRequests(config) {
  const value = config?.benchmark?.minSuccessfulRequests;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("benchmark.minSuccessfulRequests must be present in the raw run config.");
  }
  return value;
}

export function getPairMeasurements({ requests, database, placement, providerRegionCoordinates, workerColoCoordinates }) {
  const successful = requests.filter((request) => request && request.ok && request.body);
  const failed = requests.filter((request) => !request?.ok);
  const notes = new Map();

  for (const request of successful) {
    notes.set(request, requestNotes({
      request,
      body: request.body,
      database,
      placement,
      providerRegionCoordinates,
      workerColoCoordinates
    }));
  }
  for (const request of failed) {
    notes.set(request, ["failed"]);
  }

  return {
    successful,
    failed,
    notes,
    noteCounts: countValues([...notes.values()].flat())
  };
}

export function isPairReliable(successCount, minSuccessfulRequests) {
  return successCount >= minSuccessfulRequests;
}

export function parsePlacementHeader(value) {
  if (typeof value !== "string" || value.length === 0) return { placementMode: null, placementColo: null };
  const match = /^(local|remote)-([A-Z0-9]{3})$/i.exec(value.trim());
  if (!match) return { placementMode: null, placementColo: null };
  return {
    placementMode: match[1].toLowerCase(),
    placementColo: match[2].toUpperCase()
  };
}

function requestNotes({ request, body, database, placement, providerRegionCoordinates, workerColoCoordinates }) {
  const notes = [];
  if (!request.placementColo) {
    notes.push("placement_header_missing");
  } else {
    const distance = placementDistanceKm(request.placementColo, placement, providerRegionCoordinates, workerColoCoordinates);
    if (Number.isFinite(distance)) notes.push(`${Math.round(distance)}km`);
  }
  if (!d1RegionMatchesTarget(body?.d1?.regions, database)) {
    notes.push("d1_region_mismatch");
  }
  return notes;
}

function placementDistanceKm(placementColo, placement, providerRegionCoordinates, workerColoCoordinates) {
  const target = getPlacementCoordinate(placement, providerRegionCoordinates);
  const colo = getWorkerColoCoordinate(placementColo, workerColoCoordinates);
  if (!target || !colo) return null;
  return distanceKm(target[0], target[1], colo[0], colo[1]);
}

function d1RegionMatchesTarget(regions, database) {
  const target = normalizeD1Region(database?.targetLocation || database?.observedRegion);
  if (!target || !regions || typeof regions !== "object") return false;
  const observed = Object.entries(regions).filter(([, count]) => Number(count) > 0).map(([region]) => normalizeD1Region(region));
  return observed.length > 0 && observed.every((region) => region === target);
}

function getPlacementCoordinate(placement, providerRegionCoordinates) {
  const index = typeof placement === "string" ? placement.indexOf(":") : -1;
  if (index < 0) return null;
  const provider = placement.slice(0, index);
  const region = placement.slice(index + 1);
  return normalizeCoordinate(providerRegionCoordinates?.[provider]?.[region]);
}

function getWorkerColoCoordinate(workerColo, workerColoCoordinates) {
  if (!workerColo) return null;
  return normalizeCoordinate(workerColoCoordinates?.[String(workerColo).toUpperCase()]);
}

function normalizeCoordinate(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lat = Number(value[0]);
  const lon = Number(value[1]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}

function normalizeD1Region(value) {
  return value == null ? null : String(value).trim().toUpperCase();
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function countValues(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}
