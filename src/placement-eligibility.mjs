export function getMinSuccessfulRequests(config) {
  const value = config?.benchmark?.minSuccessfulRequests;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("benchmark.minSuccessfulRequests must be present in the raw run config.");
  }
  return value;
}

export function getPairMeasurements({ requests, database }) {
  const successful = requests.filter((request) => request && request.ok && request.body);
  const failed = requests.filter((request) => !request?.ok);
  const notes = new Map();

  for (const request of successful) {
    notes.set(request, requestNotes({
      request,
      body: request.body,
      database
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

function requestNotes({ request, body, database }) {
  const notes = [];
  if (!request.placementColo) {
    notes.push("placement_header_missing");
  }
  if (!d1RegionMatchesTarget(body?.d1?.regions, database)) {
    notes.push("d1_region_mismatch");
  }
  if (!d1ColoMatchesObserved(body?.d1?.colos, database)) {
    notes.push("d1_colo_mismatch");
  }
  return notes;
}

function d1RegionMatchesTarget(regions, database) {
  const target = normalizeD1Region(database?.targetLocation || database?.observedRegion);
  if (!target || !regions || typeof regions !== "object") return false;
  const observed = Object.entries(regions).filter(([, count]) => Number(count) > 0).map(([region]) => normalizeD1Region(region));
  return observed.length > 0 && observed.every((region) => region === target);
}

function normalizeD1Region(value) {
  return value == null ? null : String(value).trim().toUpperCase();
}

function d1ColoMatchesObserved(colos, database) {
  const target = normalizeD1Colo(database?.observedColo || database?.coloKey);
  if (!target || target === "UNKNOWN") return true;
  if (!colos || typeof colos !== "object") return false;
  const observed = Object.entries(colos).filter(([, count]) => Number(count) > 0).map(([colo]) => normalizeD1Colo(colo));
  return observed.length > 0 && observed.every((colo) => colo === target);
}

function normalizeD1Colo(value) {
  return value == null ? null : String(value).trim().toUpperCase();
}

function countValues(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}
