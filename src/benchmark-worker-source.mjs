export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/bench") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    const requestedQueries = Number(url.searchParams.get("queries") || env.QUERIES_PER_REQUEST || 5);
    const queries = Math.max(1, Math.min(100, Math.trunc(requestedQueries)));
    const databaseKey = url.searchParams.get("db");
    const databaseBindings = JSON.parse(env.DATABASE_BINDINGS || "{}");
    const bindingName = databaseBindings[databaseKey];
    const db = bindingName ? env[bindingName] : undefined;
    if (!db) {
      return json({ ok: false, error: "unknown_database", databaseKey }, 400);
    }

    const perQueryMs = [];
    const d1Meta = [];
    const started = performance.now();

    for (let index = 0; index < queries; index += 1) {
      const queryStarted = performance.now();
      let result;
      if (index % 3 === 0) {
        result = await db.prepare("SELECT 1 AS ok").all();
      } else if (index % 3 === 1) {
        result = await db.prepare("SELECT COUNT(*) AS count FROM bench_items").all();
      } else {
        const id = (index % 100) + 1;
        result = await db.prepare("SELECT * FROM bench_items WHERE id = ?").bind(id).all();
      }
      perQueryMs.push(performance.now() - queryStarted);
      if (result?.meta) d1Meta.push(result.meta);
    }

    const totalMs = performance.now() - started;
    const colo = request.cf?.colo || request.headers.get("cf-ray")?.split("-")[1] || null;
    return json({
      workerPlacement: env.WORKER_PLACEMENT,
      databaseKey,
      workerColo: colo,
      queries,
      totalMs,
      perQueryMs,
      d1: summarizeD1Meta(d1Meta)
    });
  }
};

function summarizeD1Meta(meta) {
  const regions = countBy(meta.map((item) => item?.served_by_region).filter(Boolean));
  const colos = countBy(meta.map((item) => item?.served_by_colo).filter(Boolean));
  const sqlDurations = meta
    .map((item) => item?.timings?.sql_duration_ms ?? item?.duration)
    .filter((value) => typeof value === "number");
  return { regions, colos, sqlDurations };
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
