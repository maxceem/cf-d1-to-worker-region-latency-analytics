export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/measure") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    const requestedQueries = Number(url.searchParams.get("queries") || env.QUERIES_PER_REQUEST);
    if (!Number.isFinite(requestedQueries)) {
      return json({ ok: false, error: "queries_required" }, 400);
    }
    const queries = Math.max(1, Math.min(100, Math.trunc(requestedQueries)));
    const perQueryMs = [];
    const perQueryNetworkMs = [];
    const d1Meta = [];
    const started = performance.now();

    for (let index = 0; index < queries; index += 1) {
      const queryStarted = performance.now();
      const result = await env.DB.prepare("SELECT 1 AS ok").all();
      const elapsedMs = performance.now() - queryStarted;
      const sqlDurationMs = getD1SqlDuration(result?.meta);
      perQueryMs.push(elapsedMs);
      perQueryNetworkMs.push(
        typeof sqlDurationMs === "number" ? Math.max(0, elapsedMs - sqlDurationMs) : elapsedMs
      );
      if (result?.meta) d1Meta.push(result.meta);
    }

    return json({
      workerPlacement: env.WORKER_PLACEMENT,
      workerColo: request.cf?.colo || request.headers.get("cf-ray")?.split("-")[1] || null,
      queries,
      totalMs: performance.now() - started,
      perQueryMs,
      perQueryNetworkMs,
      d1: summarizeD1Meta(d1Meta)
    });
  }
};

function summarizeD1Meta(meta) {
  return {
    regions: countBy(meta.map((item) => item?.served_by_region).filter(Boolean)),
    colos: countBy(meta.map((item) => item?.served_by_colo).filter(Boolean)),
    sqlDurations: meta.map(getD1SqlDuration).filter((value) => typeof value === "number")
  };
}

function getD1SqlDuration(meta) {
  return meta?.timings?.sql_duration_ms ?? meta?.duration;
}

function countBy(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
