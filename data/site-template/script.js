"use strict";
const MODEL = JSON.parse(document.getElementById("report-data").textContent);
const METRICS = window.MetricStats.METRICS;
const state = { db: (MODEL.databases[0] && MODEL.databases[0].key) || "all",
  metric: "p95", sort: "metric", dir: 1, matrixSort: "p95", matrixDir: 1, regionView: "list",
  heroM: { 1: "p95", 2: "p95", 3: "p95", 4: "p95", 5: "p95",
           6: "p95", 7: "p95", 8: "p95", 9: "p95", 10: "p95", 11: "p95",
           12: "p95", 13: "p95", 14: "p95", 15: "p95" } };
const esc = Site.escapeHtml;
const lerpColor = Site.latencyColor;

function fmt(v) { return v == null ? "—" : v.toFixed(v < 10 ? 1 : 0) + "ms"; }
function fmtNum(v) { return v == null ? "—" : v.toFixed(v < 10 ? 1 : 0); }
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function projXY(lat, lon, W, H) { return [(lon + 180) / 360 * W, (90 - lat) / 180 * H]; }
function arcPath(a, b) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const dist = Math.hypot(dx, dy) || 1;
  const curve = 0.16, nx = -dy / dist, ny = dx / dist;
  let cx = mx + nx * dist * curve, cy = my + ny * dist * curve;
  if (cy > my) { cx = mx - nx * dist * curve; cy = my - ny * dist * curve; } // bow north
  return "M" + a[0].toFixed(1) + " " + a[1].toFixed(1) +
    " Q" + cx.toFixed(1) + " " + cy.toFixed(1) + " " + b[0].toFixed(1) + " " + b[1].toFixed(1);
}
function sortedCountKeys(obj) {
  return Object.entries(obj || {})
    .filter(([key, value]) => key && Number(value) > 0)
    .sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}
function sortedCountEntries(obj) {
  return Object.entries(obj || {})
    .filter(([key, value]) => key && Number(value) > 0)
    .sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
}
function placementColoEntries(item) {
  const entries = sortedCountEntries(item.placementColos);
  const missing = Number((item.noteCounts || {}).placement_header_missing || 0);
  if (missing > 0) entries.push(["-", missing]);
  return entries.sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
}
function placementColoText(item) {
  const names = placementColoEntries(item).map(([name]) => name);
  return names.length ? names.join(",") : "";
}
function placementLabelText(item) {
  const suffix = placementColoText(item);
  return suffix ? item.placement + " / " + suffix : item.placement;
}
function placementLabelHtml(item) {
  const suffix = placementColoText(item);
  return suffix
    ? esc(item.placement) + ' <span class="placement-colo">/ ' + esc(suffix) + '</span>'
    : esc(item.placement);
}
function placementCoord(placement) {
  const i = placement.indexOf(":");
  if (i < 0) return null;
  const prov = placement.slice(0, i), region = placement.slice(i + 1);
  return (MODEL.coords[prov] || {})[region] || null;
}
function primaryPlacementColo(item) {
  const names = sortedCountKeys(item.placementColos);
  return names.find(name => (MODEL.coloCoords || {})[name]) || names[0] || null;
}
function observedPlaceCoord(item) {
  const colo = primaryPlacementColo(item);
  if (colo && (MODEL.coloCoords || {})[colo]) return (MODEL.coloCoords || {})[colo];
  return placementCoord(item.placement);
}
function mergePairColos(target, pair) {
  for (const [colo, count] of Object.entries(pair.placementColos || {})) {
    target.placementColos[colo] = (target.placementColos[colo] || 0) + Number(count || 0);
  }
  for (const [note, count] of Object.entries(pair.noteCounts || {})) {
    target.noteCounts[note] = (target.noteCounts[note] || 0) + Number(count || 0);
  }
}
function counts(obj) {
  const e = Object.entries(obj || {});
  if (!e.length) return "—";
  return e.sort((a,b)=>b[1]-a[1]).map(([k,v]) => k + ":" + v).join(", ");
}
function dbRecord(key) {
  return MODEL.databases.find(d => d.key === key) || null;
}
function dbRegionLabel(key) {
  const d = dbRecord(key);
  return d ? d.observedRegion || d.label : key;
}
function dbColoLabel(key) {
  const d = dbRecord(key);
  const colos = (d?.d1Colos || []).filter(Boolean);
  return colos.length ? colos.join(", ") : d?.d1Colo || "";
}
function dbLabelText(key) {
  const region = dbRegionLabel(key);
  const colo = dbColoLabel(key);
  return colo ? region + " / " + colo : region;
}
function dbLabelHtml(key) {
  const region = esc(dbRegionLabel(key));
  const colo = dbColoLabel(key);
  return colo ? region + ' <span class="d1-colo">/ ' + esc(colo) + '</span>' : region;
}
function dbSvgLabel(key) {
  const region = esc(dbRegionLabel(key));
  const colo = dbColoLabel(key);
  return colo ? region + '<tspan class="md1colo"> / ' + esc(colo) + '</tspan>' : region;
}
function dbCoord(key) {
  const colo = dbColoLabel(key).split(",")[0].trim();
  return colo ? (MODEL.coloCoords || {})[colo] || (MODEL.d1coords || {})[(key || "").toLowerCase()] : (MODEL.d1coords || {})[(key || "").toLowerCase()];
}
function dbLabel(key) {
  return dbLabelText(key);
}

function render() {
  const app = document.getElementById("app");
  app.innerHTML =
    header() +
    heroExplorations() +
    '<div id="region-panel">' + regionPanel() + '</div>' +
    metaFooter() +
    Site.pageFooter(MODEL);
  wire();
}

function renderRegionPanel() {
  const panel = document.getElementById("region-panel");
  if (!panel) {
    render();
    return;
  }
  panel.innerHTML = regionPanel();
  wireRegionPanel();
}

function syncMapCardSelection() {
  document.querySelectorAll(".v12card[data-db]").forEach(card => {
    const selected = state.db === card.getAttribute("data-db");
    card.classList.toggle("sel", selected);
    card.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function header() {
  return '<div class="wrap-inner">' +
    '<h1>Cloudflare D1-to-Worker Latency Analytics</h1>' +
    '<h2 class="why">Why it matters</h2>' +
    '<div class="intro">' +
      '<div class="intro-text">' +
        '<p class="sub">When a user calls a Cloudflare Worker that queries a D1 database, each D1 round trip can add ' +
          'latency to the final response.</p>' +
        '<p class="idea-cap">This benchmark measures the latency between D1 and a Worker when that Worker is pinned ' +
          'to a specific third-party cloud region, such as AWS, GCP, or Azure, using Cloudflare ' +
          '<a href="https://developers.cloudflare.com/workers/configuration/placement/#specify-a-cloud-region" target="_blank" rel="noopener"><code>region</code> placement configuration</a>.</p>' +
      '</div>' +
      '<div class="intro-fig">' + ideaDiagram() + '</div>' +
    '</div>' +
  '</div>';
}

// Adapted from Cloudflare's Workers placement docs: a user reaches the Worker,
// and the Worker issues D1 queries. The benchmark measures D1 latency for each
// selected Worker placement.
function ideaDiagram() {
  const pin = '<g class="pin"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></g>';
  const node = (cx, loc, label, icon) =>
    '<g transform="translate(' + cx + ',0)">' +
      '<g transform="translate(-80,8)">' + pin + '</g>' +
      '<text class="loc" x="-50" y="26">' + loc + '</text>' +
      '<g transform="translate(0,132)">' + icon + '</g>' +
      '<text class="lbl" x="0" y="234" text-anchor="middle">' + label + '</text>' +
    '</g>';
  const browser =
    '<g class="ln">' +
      '<rect x="-36" y="-34" width="72" height="68" rx="6"/>' +
      '<line x1="-36" y1="-19" x2="36" y2="-19"/>' +
    '</g>' +
    '<circle class="dot" cx="-29" cy="-26.5" r="1.7"/><circle class="dot" cx="-23" cy="-26.5" r="1.7"/><circle class="dot" cx="-17" cy="-26.5" r="1.7"/>' +
    '<g class="ln"><circle cx="0" cy="-1" r="9"/><path d="M-15,27 a15,14 0 0 1 30,0"/></g>';
  const worker = '<g class="wkmark" transform="scale(5) translate(-8,-8)">' +
    '<path d="M6.21 12.293l-3.215-4.3 3.197-4.178-.617-.842-3.603 4.712-.005.603 3.62 4.847.623-.842z"></path>' +
    '<path d="M7.332 1.988H6.095l4.462 6.1-4.357 5.9h1.245L11.8 8.09 7.332 1.988z"></path>' +
    '<path d="M9.725 1.988H8.472l4.533 6.027-4.533 5.973h1.255l4.303-5.67v-.603L9.725 1.988z"></path>' +
  '</g>';
  const db =
    '<g class="ln">' +
      '<ellipse cx="0" cy="-22" rx="22" ry="8"/>' +
      '<path d="M-22,-22 V18 a22,8 0 0 0 44,0 V-22"/>' +
      '<path d="M-22,-9 a22,8 0 0 0 44,0"/><path d="M-22,4 a22,8 0 0 0 44,0"/>' +
    '</g>';
  const ln = (x1, y1, x2, y2) =>
    '<line class="arw" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" marker-end="url(#ah)"/>';
  const arrows =
    ln(250, 122, 505, 122) + ln(510, 138, 255, 138) +
    ln(662, 106, 768, 106) + ln(768, 122, 662, 122) + ln(662, 138, 768, 138) + ln(768, 154, 662, 154);
  return '<figure class="idea-fig">' +
    '<svg class="idea-svg" viewBox="66 4 816 240" preserveAspectRatio="xMidYMid meet" role="img" ' +
      'aria-label="A user reaches the Worker in one round trip; the Worker exchanges many round trips with the database.">' +
      '<defs><marker id="ah" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto" markerUnits="userSpaceOnUse">' +
        '<path class="arw-head" d="M0,0 L6,3 L0,6 Z"/></marker></defs>' +
      arrows +
      node(160, "Sydney, AU", "User", browser) +
      node(600, "Frankfurt, DE", "Worker", worker) +
      node(820, "Frankfurt, DE", "Database", db) +
    '</svg>' +
  '</figure>';
}

function metaFooter() {
  const r = MODEL.run;
  const b = r.benchmark || {};
  const num = (n) => (n == null ? "—" : Number(n).toLocaleString());
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };
  let window = "—", duration = "—";
  if (r.startedAt && r.completedAt) {
    const s = new Date(r.startedAt), e = new Date(r.completedAt);
    const sameDay = s.toDateString() === e.toDateString();
    const endStr = sameDay ? e.toLocaleString([], { hour: "numeric", minute: "2-digit" }) : fmtTime(r.completedAt);
    window = fmtTime(r.startedAt) + " → " + endStr;
    const mins = Math.round((e - s) / 60000);
    duration = (mins >= 60 ? Math.floor(mins / 60) + "h " : "") + (mins % 60) + "m";
  }
  const measured = b.measuredRequests != null
    ? b.measuredRequests
    : Math.max.apply(null, MODEL.pairs.map(p => p.requestCount || 0).concat(0));
  const totalReq = MODEL.pairs.length * measured;
  const successfulReq = MODEL.pairs.reduce((sum, p) => sum + (p.successCount || 0), 0);
  const failedReq = MODEL.pairs.reduce((sum, p) => sum + (p.errorCount || 0), 0);
  const row = (k, v, cls) => '<tr><th scope="row">' + k + '</th><td' +
    (cls ? ' class="' + cls + '"' : '') + '>' + v + '</td></tr>';
  const rows =
    row("Run window", esc(window), "long") +
    row("Duration", duration) +
    row("D1 regions", num(MODEL.databases.length)) +
    row("Worker locations", num(MODEL.placements.length)) +
    row("Pairs tested", num(MODEL.pairs.length)) +
    row("Requests per pairing", num(measured)) +
    row("Minimum successful requests", num(b.minSuccessfulRequests || r.minSuccessfulRequests)) +
    row("Queries per request", num(b.queriesPerRequest)) +
    row("Warm-up per pairing", num(b.warmupRequests)) +
    row("Request timeout", b.requestTimeoutMs != null ? Math.round(b.requestTimeoutMs / 1000) + " s" : "—") +
    row("Total measured requests", num(totalReq)) +
    row("Successful measured requests", num(successfulReq) + (failedReq ? " successful, " + num(failedReq) + " failed" : ""));
  return '<section class="details">' +
    '<h2>How this was measured</h2>' +
    '<p class="sub">Every Worker location was benchmarked against every D1 region. For each pairing we sent ' +
      num(measured) + ' timed requests' + (b.warmupRequests ? ' (after ' + num(b.warmupRequests) + ' warm-ups)' : '') +
      ', each running ' + (b.queriesPerRequest ? num(b.queriesPerRequest) + ' sequential D1 queries' : 'its D1 queries') +
      ', and recorded per-query network latency measured inside the Worker. Pair metrics apply the selected metric to the queries in each request, then apply the same metric across requests.</p>' +
    '<table class="measure-table"><tbody>' + rows + '</tbody></table>' +
  '</section>';
}

function tabsPanel() {
  // Row 1: one tab per D1 region plus "All" (the ranked view across every pair).
  let dbTabs = '<button class="tab' + (state.db === "all" ? " active" : "") + '" data-db="all">All</button>';
  for (const d of MODEL.databases) {
    dbTabs += '<button class="tab' + (state.db === d.key ? " active" : "") + '" data-db="' + esc(d.key) + '">' +
      dbLabelHtml(d.key) + '</button>';
  }
  return '<div class="tabs">' +
    '<div class="tabrow"><span class="tablabel">D1 region</span><div class="tabset">' + dbTabs + '</div></div>' +
    '<div class="tabrow">' + metricSwitch("Metric") + '</div>' +
  '</div>';
}

function metricVal(p) { return p[state.metric]; }
function pairStatus(p) { return p.status === "ok" ? "OK" : "Failed"; }
function successText(p) { return (p.successCount || 0) + "/" + (p.requestCount || 0); }

// --- "Best worker regions": shared data helper + 5 concept explorations ---
function bestPerDb(metricKey) {
  return MODEL.databases.map(d => {
    let best = null;
    for (const p of MODEL.pairs) {
      if (p.dbKey !== d.key) continue;
      const v = p[metricKey];
      if (v == null) continue;
      if (!best || v < best.value) best = { value: v, placement: p.placement, pair: p };
    }
    return { key: d.key, name: dbLabelText(d.key), nameHtml: dbLabelHtml(d.key), best: best };
  });
}
function byBest(a, b) {
  if (!a.best && !b.best) return 0;
  if (!a.best) return 1;
  if (!b.best) return -1;
  return a.best.value - b.best.value;
}
function heroRange(entries) {
  const v = entries.filter(e => e.best).map(e => e.best.value);
  const lo = v.length ? Math.min.apply(null, v) : 0;
  const hi = v.length ? Math.max.apply(null, v) : 1;
  return { lo: lo, hi: hi, span: (hi - lo) || 1 };
}
function heroTabs(ver, cls) {
  const sel = state.heroM[ver];
  let t = "";
  for (const m of METRICS) {
    t += '<button class="' + cls + (sel === m.key ? " on" : "") + '" data-herov="' + ver +
      '" data-herok="' + m.key + '">' + esc(m.label) + '</button>';
  }
  return t;
}

function metricSwitch(label) {
  return Site.segmentedControl({
    label,
    options: METRICS.map(metric => ({ value: metric.key, label: metric.label })),
    current: state.metric,
    attr: "data-metric",
  });
}

function heroExplorations() {
  return '<h2>Best worker location per D1 region</h2>' +
    '<div class="hx-lab">' + heroV13() + '</div>';
}

// 01 — Editorial leaderboard (ranked typographic list on warm paper)
function heroV1() {
  const entries = bestPerDb(state.heroM[1]).slice().sort(byBest);
  let rows = "", i = 0;
  for (const e of entries) {
    i++;
    const num = (i < 10 ? "0" : "") + i;
    const val = e.best ? fmtNum(e.best.value) : "—";
    const loc = e.best ? placementLabelHtml(e.best.pair) : "no data";
    rows += '<div class="v1row' + (i === 1 ? " v1-lead" : "") + '">' +
      '<span class="v1rank">' + num + '</span>' +
      '<span class="v1region">' + (e.nameHtml || esc(e.name)) + '</span>' +
      '<span class="v1loc">' + loc + '</span>' +
      '<span class="v1val">' + val + '<i>ms</i></span>' +
    '</div>';
  }
  return '<section class="hx hx1">' +
    '<div class="hx1head">' +
      '<div><div class="hx1kick">01 — Leaderboard</div>' +
      '<div class="hx1title">Fastest worker per region</div></div>' +
      '<div class="hx1tabs">' + heroTabs(1, "v1tab") + '</div>' +
    '</div>' + rows +
  '</section>';
}

// 02 — Scale: every region plotted on one shared latency axis
function heroV2() {
  const entries = bestPerDb(state.heroM[2]).filter(e => e.best).slice().sort(byBest);
  const vals = entries.map(e => e.best.value);
  const lo = vals.length ? Math.min.apply(null, vals) : 0;
  const hi = vals.length ? Math.max.apply(null, vals) : 1;
  const span = (hi - lo) || 1;
  let marks = "";
  entries.forEach((e, idx) => {
    const pct = (e.best.value - lo) / span * 100;
    const dir = idx % 2 === 0 ? "up" : "down";
    marks += '<div class="v2mark ' + dir + '" style="left:' + pct + '%">' +
      '<div class="v2lab"><span class="v2reg">' + (e.nameHtml || esc(e.name)) + '</span>' +
        '<span class="v2v">' + fmtNum(e.best.value) + '<i>ms</i></span>' +
        '<span class="v2loc">' + placementLabelHtml(e.best.pair) + '</span></div>' +
      '<div class="v2stem"></div><div class="v2dot"></div>' +
    '</div>';
  });
  return '<section class="hx hx2">' +
    '<div class="hx2head"><span class="hx2kick">02 / Scale</span>' +
      '<span class="hx2sub">best latency on a shared axis</span>' +
      '<span class="hx2tabs">' + heroTabs(2, "v2tab") + '</span></div>' +
    '<div class="v2plot"><div class="v2track">' + marks + '</div>' +
      '<div class="v2end v2lo">' + fmtNum(lo) + 'ms</div>' +
      '<div class="v2end v2hi">' + fmtNum(hi) + 'ms</div></div>' +
  '</section>';
}

// 03 — Spotlight: one hero stat for the single best pairing + supporting list
function heroV3() {
  const entries = bestPerDb(state.heroM[3]).filter(e => e.best).slice().sort(byBest);
  const lead = entries[0];
  let rest = "";
  for (const e of entries.slice(1)) {
    rest += '<div class="v3row"><span class="v3reg">' + (e.nameHtml || esc(e.name)) + '</span>' +
      '<span class="v3loc">' + placementLabelHtml(e.best.pair) + '</span>' +
      '<span class="v3v">' + fmtNum(e.best.value) + '<i>ms</i></span></div>';
  }
  const leadHtml = lead ? '<div class="v3lead">' +
    '<div class="v3badge">★ Fastest pairing</div>' +
    '<div class="v3num">' + fmtNum(lead.best.value) + '<span>ms</span></div>' +
    '<div class="v3route"><b>' + (lead.nameHtml || esc(lead.name)) + '</b><span class="v3arr">→</span>' +
      placementLabelHtml(lead.best.pair) + '</div>' +
  '</div>' : '';
  return '<section class="hx hx3">' +
    '<div class="hx3tabs">' + heroTabs(3, "v3tab") + '</div>' +
    '<div class="v3grid">' + leadHtml + '<div class="v3rest">' + rest + '</div></div>' +
  '</section>';
}

// 04 — Magnitude: industrial horizontal bar chart
function heroV4() {
  const entries = bestPerDb(state.heroM[4]).filter(e => e.best).slice().sort(byBest);
  const max = entries.length ? entries[entries.length - 1].best.value : 1;
  let rows = "";
  entries.forEach((e, i) => {
    const w = Math.max(4, e.best.value / max * 100);
    rows += '<div class="v4row' + (i === 0 ? " v4best" : "") + '">' +
      '<div class="v4reg">' + (e.nameHtml || esc(e.name)) + '</div>' +
      '<div class="v4barwrap"><div class="v4bar" style="width:' + w + '%"></div>' +
        '<span class="v4loc">' + placementLabelHtml(e.best.pair) + '</span></div>' +
      '<div class="v4val">' + fmtNum(e.best.value) + '<i>ms</i></div>' +
    '</div>';
  });
  return '<section class="hx hx4">' +
    '<div class="hx4head"><span class="hx4kick">04 · Magnitude</span>' +
      '<div class="hx4tabs">' + heroTabs(4, "v4tab") + '</div></div>' + rows +
  '</section>';
}

// 05 — Departures board: D1 → Worker framed as routes
function heroV5() {
  const entries = bestPerDb(state.heroM[5]).slice().sort(byBest);
  let rows = "";
  for (const e of entries) {
    const v = e.best ? fmtNum(e.best.value) : "—";
    const dest = e.best ? placementLabelHtml(e.best.pair) : "—";
    rows += '<div class="v5row"><span class="v5reg">' + (e.nameHtml || esc(e.name)) + '</span>' +
      '<span class="v5plane">✈</span><span class="v5dest">' + dest + '</span>' +
      '<span class="v5time">' + v + '<i>ms</i></span></div>';
  }
  return '<section class="hx hx5"><div class="v5board">' +
    '<div class="v5top"><span class="v5dot"></span>' +
      '<span class="v5title">D1 ▸ Worker Departures</span>' +
      '<span class="v5tabs">' + heroTabs(5, "v5tab") + '</span></div>' +
    '<div class="v5cols"><span>Region</span><span></span><span>Best worker</span><span>Latency</span></div>' +
    rows +
  '</div></section>';
}

// 06 — Signal traces: each D1↔worker pairing as a PCB circuit trace
function heroV6() {
  const entries = bestPerDb(state.heroM[6]);
  const r = heroRange(entries);
  let rows = "";
  for (const e of entries) {
    const has = !!e.best;
    const col = has ? lerpColor((e.best.value - r.lo) / r.span) : "#3a4a4a";
    const val = has ? fmtNum(e.best.value) : "—";
    const dest = has ? placementLabelHtml(e.best.pair) : "no signal";
    rows += '<div class="v6trace">' +
      '<span class="v6pad v6src">' + (e.nameHtml || esc(e.name)) + '</span>' +
      '<span class="v6wire" style="--c:' + col + '">' +
        '<span class="v6chip" style="color:' + col + ';border-color:' + col + '">' + val + '<i>ms</i></span>' +
      '</span>' +
      '<span class="v6pad v6dst">' + dest + '</span>' +
    '</div>';
  }
  return '<section class="hx hx6">' +
    '<div class="hx6head"><span class="hx6kick">06 ▮ Signal traces</span>' +
      '<span class="hx6sub">D1 ↔ best worker, etched</span>' +
      '<span class="hx6tabs">' + heroTabs(6, "v6tab") + '</span></div>' +
    '<div class="v6board">' + rows + '</div>' +
  '</section>';
}

// 07 — Dials: a speedometer gauge per D1, latency as the needle
function heroV7() {
  const entries = bestPerDb(state.heroM[7]);
  const r = heroRange(entries);
  let cards = "";
  for (const e of entries) {
    const has = !!e.best;
    const t = has ? (e.best.value - r.lo) / r.span : 0;
    const pct = has ? Math.max(5, Math.min(100, 12 + t * 88)) : 0;
    const col = has ? lerpColor(t) : "#2a3340";
    cards += '<div class="v7cell">' +
      '<div class="v7gauge" style="--p:' + pct + ';--c:' + col + '">' +
        '<div class="v7inner"><span class="v7v" style="color:' + col + '">' + (has ? fmtNum(e.best.value) : "—") +
          '</span><span class="v7u">ms</span></div>' +
      '</div>' +
      '<div class="v7reg">' + (e.nameHtml || esc(e.name)) + '</div>' +
      '<div class="v7loc">' + (has ? placementLabelHtml(e.best.pair) : "—") + '</div>' +
    '</div>';
  }
  return '<section class="hx hx7">' +
    '<div class="hx7head"><span class="hx7kick">07 — Dials</span>' +
      '<span class="hx7tabs">' + heroTabs(7, "v7tab") + '</span></div>' +
    '<div class="v7grid">' + cards + '</div>' +
  '</section>';
}

// 08 — Manifesto: each region as a bold typographic recommendation
function heroV8() {
  const entries = bestPerDb(state.heroM[8]);
  let lines = "";
  for (const e of entries) {
    const has = !!e.best;
    lines += '<div class="v8line">' +
      '<span class="v8reg">' + (e.nameHtml || esc(e.name)) + '</span>' +
      '<span class="v8mid">deploy on</span>' +
      '<span class="v8loc">' + (has ? placementLabelHtml(e.best.pair) : "—") + '</span>' +
      '<span class="v8at">·</span>' +
      '<span class="v8v">' + (has ? fmtNum(e.best.value) : "—") + '<i>ms</i></span>' +
    '</div>';
  }
  return '<section class="hx hx8">' +
    '<div class="hx8head"><span class="hx8kick">08 / Manifesto</span>' +
      '<span class="hx8tabs">' + heroTabs(8, "v8tab") + '</span></div>' +
    '<div class="v8body">' + lines + '</div>' +
  '</section>';
}

// 09 — Routing manifest: a terminal printout, one line per D1
function heroV9() {
  const k = state.heroM[9];
  const entries = bestPerDb(k);
  let lines = "";
  for (const e of entries) {
    const has = !!e.best;
    lines += '<div class="v9line">' +
      '<span class="v9reg">' + (e.nameHtml || esc(e.name)) + '</span>' +
      '<span class="v9arr">→</span>' +
      '<span class="v9loc">' + (has ? placementLabelHtml(e.best.pair) : "(none)") + '</span>' +
      '<span class="v9v">' + (has ? fmtNum(e.best.value) + "ms" : "—") + '</span>' +
    '</div>';
  }
  return '<section class="hx hx9"><div class="v9term">' +
    '<div class="v9bar"><span class="v9b r"></span><span class="v9b y"></span><span class="v9b g"></span>' +
      '<span class="v9file">d1-routes.sh</span>' +
      '<span class="v9tabs">' + heroTabs(9, "v9tab") + '</span></div>' +
    '<div class="v9body">' +
      '<div class="v9cmd"><span class="v9prompt">$</span> d1 routes --best --metric ' + esc(k) + '</div>' +
      '<div class="v9comment"># lowest-latency worker placement for each D1 region</div>' +
      lines +
    '</div></div></section>';
}

// 10 — Postage: each region as a collectible stamp with a latency denomination
function heroV10() {
  const entries = bestPerDb(state.heroM[10]);
  const r = heroRange(entries);
  let cards = "", i = 0;
  for (const e of entries) {
    i++;
    const has = !!e.best;
    const col = has ? lerpColor((e.best.value - r.lo) / r.span) : "#9a8a66";
    const rot = (i % 2 === 0 ? 1 : -1) * (1 + (i % 3));
    cards += '<div class="v10stamp" style="transform:rotate(' + rot + 'deg)">' +
      '<div class="v10perf"><div class="v10inner">' +
        '<div class="v10top"><span class="v10post">PAR AVION</span><span class="v10reg">' + (e.nameHtml || esc(e.name)) + '</span></div>' +
        '<div class="v10val" style="color:' + col + '">' + (has ? fmtNum(e.best.value) : "—") + '<span>ms</span></div>' +
        '<div class="v10loc">' + (has ? placementLabelHtml(e.best.pair) : "—") + '</div>' +
      '</div></div>' +
    '</div>';
  }
  return '<section class="hx hx10">' +
    '<div class="hx10head"><span class="hx10kick">10 ✦ Postage</span>' +
      '<span class="hx10tabs">' + heroTabs(10, "v10tab") + '</span></div>' +
    '<div class="v10grid">' + cards + '</div>' +
  '</section>';
}

// 11 — Cartogram cards: a cropped world map per D1 fading into a latency band
function heroV11() {
  const metricKey = state.heroM[11];
  const entries = bestPerDb(metricKey);
  const scale = metricScale(metricKey);
  const B = MODEL.basemap;
  let landPaths = "";
  if (B) for (const d of B.paths) landPaths += '<path d="' + d + '"/>';
  let cards = "";
  for (const e of entries) {
    const has = !!e.best;
    const col = has ? metricColor(e.best.value, scale) : "#3a4654";
    const ll = dbCoord(e.key);
    let map = "";
    if (ll && B) {
      const cx = (ll[1] + 180) / 360 * B.w;
      const cy = (90 - ll[0]) / 180 * B.h;
      const wide = (e.key || "").toLowerCase() === "oc";
      const vw = wide ? 560 : 320, vh = wide ? 400 : 230;
      let x0 = Math.max(0, Math.min(B.w - vw, cx - vw / 2));
      let y0 = Math.max(0, Math.min(B.h - vh, cy - vh / 2));
      map = '<svg class="v11svg" viewBox="' + x0 + ' ' + y0 + ' ' + vw + ' ' + vh +
        '" preserveAspectRatio="xMidYMid slice">' +
        '<g class="v11land">' + landPaths + '</g>' +
        '<circle class="v11halo" cx="' + cx + '" cy="' + cy + '" r="16"></circle>' +
        '<circle class="v11pin" cx="' + cx + '" cy="' + cy + '" r="8"></circle>' +
      '</svg>';
    }
    cards += '<div class="v11card">' +
      '<div class="v11map">' + map +
        '<div class="v11fade"></div>' +
        '<div class="v11name">' + (e.nameHtml || esc(e.name)) + '</div>' +
        '<div class="v11foot">' +
          '<div class="v11val" style="color:' + col + '">' + (has ? fmtNum(e.best.value) : "—") + '<span>ms</span></div>' +
          '<div class="v11loc">' + (has ? placementLabelHtml(e.best.pair) : "no data") + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  return '<section class="hx hx11">' +
    '<div class="hx11head"><span class="hx11kick">11 ◵ Cartogram</span>' +
      '<span class="hx11tabs">' + heroTabs(11, "v11tab") + '</span></div>' +
    '<div class="v11grid">' + cards + '</div>' +
  '</section>';
}

// 12 — Cartogram wearing the Spotlight block's skin; schemeCls recolours it.
function cartoSpot(ver, schemeCls, kicker) {
  const entries = bestPerDb(state.metric);
  const scale = metricScale(state.metric);
  const B = MODEL.basemap;
  let landPaths = "";
  if (B) for (const d of B.paths) landPaths += '<path d="' + d + '"/>';
  let cards = "";
  for (const e of entries) {
    const has = !!e.best;
    const col = has ? metricColor(e.best.value, scale) : null;
    const ll = dbCoord(e.key);
    let map = "";
    if (ll && B) {
      const cx = (ll[1] + 180) / 360 * B.w;
      const cy = (90 - ll[0]) / 180 * B.h;
      const wide = (e.key || "").toLowerCase() === "oc";
      const vw = wide ? 560 : 320, vh = wide ? 400 : 230;
      let x0 = Math.max(0, Math.min(B.w - vw, cx - vw / 2));
      let y0 = Math.max(0, Math.min(B.h - vh, cy - vh / 2));
      // Scale the dot to the crop width so it renders the same size on every card.
      const pr = vw / 70, hr = vw / 35, sw = vw / 350;
      map = '<svg class="v12svg" viewBox="' + x0 + ' ' + y0 + ' ' + vw + ' ' + vh +
        '" preserveAspectRatio="xMidYMid slice">' +
        '<g class="v12land">' + landPaths + '</g>' +
        '<circle class="v12halo" cx="' + cx + '" cy="' + cy + '" r="' + hr + '"></circle>' +
        '<circle class="v12pin" cx="' + cx + '" cy="' + cy + '" r="' + pr + '" stroke-width="' + sw + '"></circle>' +
      '</svg>';
    }
    const sel = state.db === e.key ? " sel" : "";
    cards += '<div class="v12card' + sel + '" data-db="' + esc(e.key) + '" tabindex="0" role="button" aria-pressed="' + (sel ? "true" : "false") + '">' +
      '<div class="v12map">' + map +
        '<div class="v12fade"></div>' +
        '<div class="v12name">' + (e.nameHtml || esc(e.name)) + '</div>' +
        '<div class="v12foot">' +
          '<div class="v12val"' + (col ? ' style="color:' + col + '"' : '') + '>' + (has ? fmtNum(e.best.value) : "—") + '<span>ms</span></div>' +
          '<div class="v12loc">' + (has ? placementLabelHtml(e.best.pair) : "no data") + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  return '<section class="hx hx12 ' + schemeCls + '">' +
    '<div class="hx12head"><span class="hx12kick">' + kicker + '</span>' +
      '<span class="hx12tabs">' + metricPills() + '</span></div>' +
    '<div class="v12grid">' + cards + '</div>' +
  '</section>';
}
// Global metric ("P") filter pills — drives the cards and the stats below.
function metricPills() {
  return metricSwitch("");
}
function heroV12() { return cartoSpot(12, "", "12 ◵ Cartogram · Spotlight skin"); }
function heroV13() { return cartoSpot(13, "s-slate", ""); }
function heroV14() { return cartoSpot(14, "s-sage", "14 ◵ Sage"); }
function heroV15() { return cartoSpot(15, "s-clay", "15 ◵ Clay"); }

function matrixPanel() {
  const dbs = MODEL.databases;
  const cols = METRICS;
  // For each D1 region and each metric, find the best (lowest) value across all
  // Worker placements and remember which placement achieved it.
  const bestByDbMetric = {}; // dbKey -> metricKey -> { value, placement }
  for (const d of dbs) {
    const perMetric = {};
    const dbPairs = MODEL.pairs.filter(x => x.dbKey === d.key);
    for (const m of cols) {
      let best = null;
      for (const p of dbPairs) {
        const v = p[m.key];
        if (v == null) continue;
        if (!best || v < best.value) best = { value: v, placement: p.placement, pair: p };
      }
      perMetric[m.key] = best;
    }
    bestByDbMetric[d.key] = perMetric;
  }
  // Per-metric colour range, computed across each column's best values.
  const ranges = {};
  for (const m of cols) {
    const vals = dbs.map(d => bestByDbMetric[d.key][m.key]).filter(b => b).map(b => b.value);
    const lo = vals.length ? Math.min.apply(null, vals) : 0;
    const hi = vals.length ? Math.max.apply(null, vals) : 1;
    ranges[m.key] = { lo, span: (hi - lo) || 1 };
  }
  // Optionally sort the D1 rows by a clicked metric column's best value.
  let orderedDbs = dbs.slice();
  if (state.matrixSort) {
    orderedDbs.sort((a, b) => {
      const av = (bestByDbMetric[a.key][state.matrixSort] || {}).value;
      const bv = (bestByDbMetric[b.key][state.matrixSort] || {}).value;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * state.matrixDir;
    });
  }
  const arrow = m => state.matrixSort === m ? (state.matrixDir === 1 ? " ▲" : " ▼") : "";
  let head = '<tr><th class="rowhead l">D1 region ＼ One-query metric (ms)</th>';
  for (const m of cols) head += '<th class="col' + (state.matrixSort === m.key ? " sorted" : "") + '" data-msort="' + m.key + '">' + esc(m.label) + arrow(m.key) + '</th>';
  head += '</tr>';
  let rows = "";
  for (const d of orderedDbs) {
    rows += '<tr><th class="rowhead l"><span class="tag d1">' + dbLabelHtml(d.key) + '</span></th>';
    for (const m of cols) {
      const sorted = state.matrixSort === m.key ? " sorted" : "";
      const best = bestByDbMetric[d.key][m.key];
      if (!best) { rows += '<td class="cell na' + sorted + '">—</td>'; continue; }
      const r = ranges[m.key];
      const t = (best.value - r.lo) / r.span;
      const bg = lerpColor(t);
      rows += '<td class="cell' + sorted + '" style="background:' + bg + '22" title="' +
        esc(dbLabelText(d.key)) + ' — best one-query ' + esc(m.label) + ': ' + fmt(best.value) + ' via ' + esc(placementLabelText(best.pair)) + '">' +
        '<span class="v" style="color:' + bg + '">' + fmtNum(best.value) + '</span>' +
        '<span class="loc">' + placementLabelHtml(best.pair) + '</span></td>';
    }
    rows += '</tr>';
  }
  return '<h2>Best one-query latency per D1 region</h2>' +
    '<div class="panel nopad">' +
      '<div class="matrix-scroll"><table class="matrix"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>' +
    '</div>';
}

function metricLabel() {
  return (METRICS.find(m => m.key === state.metric) || {}).label || state.metric;
}
function queryMetricLabel() {
  return metricLabel() + " / query";
}

function sortedPairs(pairs) {
  const dir = state.dir;
  const key = state.sort;
  const cmp = (a, b) => {
    let av, bv;
    if (key === "db") { av = dbLabelText(a.dbKey); bv = dbLabelText(b.dbKey); return av.localeCompare(bv) * dir; }
    if (key === "placement") return a.placement.localeCompare(b.placement) * dir;
    if (key === "status") return pairStatus(a).localeCompare(pairStatus(b)) * dir;
    if (key === "metric") { av = metricVal(a); bv = metricVal(b); }
    else { av = a[key]; bv = b[key]; }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * dir;
  };
  return pairs.slice().sort(cmp);
}

function tableHead(cols) {
  return '<tr>' + cols.map(c =>
    '<th class="' + (c.l ? "l " : "") + '" data-sort="' + c.key + '">' + c.label +
      (state.sort === c.key ? (state.dir === 1 ? " ▲" : " ▼") : "") + '</th>'
  ).join("") + '</tr>';
}

function globalTablePanel() {
  const cols = [
    { key: "db", label: "D1 region", l: true },
    { key: "placement", label: "Worker location", l: true },
    { key: "metric", label: queryMetricLabel() },
    { key: "avg", label: "Avg/q" },
    { key: "p50", label: "p50/q" },
    { key: "p95", label: "p95/q" },
    { key: "p99", label: "p99/q" },
    { key: "successCount", label: "Successful" },
    { key: "status", label: "Status" },
    { key: "errorCount", label: "Errors" },
  ];
  const pairs = sortedPairs(MODEL.pairs);
  const bestKey = MODEL.best ? MODEL.best.dbKey + "|" + MODEL.best.placement : null;
  let rows = "";
  for (const p of pairs) {
    const isBest = bestKey === p.dbKey + "|" + p.placement;
    rows += '<tr class="' + (isBest ? "best" : "") + (p.status === "failed" ? " failed" : "") + '">' +
      '<td class="l"><span class="tag d1">' + dbLabelHtml(p.dbKey) + '</span></td>' +
      '<td class="l"><span class="tag wk">' + placementLabelHtml(p) + '</span>' + (isBest ? ' <span class="tag win">best</span>' : '') + '</td>' +
      '<td class="metric">' + fmt(metricVal(p)) + '</td>' +
      '<td>' + fmt(p.avg) + '</td>' +
      '<td>' + fmt(p.p50) + '</td>' +
      '<td>' + fmt(p.p95) + '</td>' +
      '<td>' + fmt(p.p99) + '</td>' +
      '<td title="successful / measured">' + successText(p) + '</td>' +
      '<td><span class="tag ' + (p.status === "ok" ? "ok" : "fail") + '">' + pairStatus(p) + '</span></td>' +
      '<td class="' + (p.errorCount ? "" : "muted") + '">' + p.errorCount + '</td>' +
    '</tr>';
  }
  if (!rows) rows = '<tr><td colspan="10" class="empty">No successful measurements.</td></tr>';
  return '<h2>All pairs ranked by one-query latency</h2>' +
    '<div class="panel"><table id="ptable"><thead>' + tableHead(cols) + '</thead><tbody>' + rows + '</tbody></table></div>';
}

function regionPanel() {
  if (state.db === "all") return allRegionPanel();

  const d = MODEL.databases.find(x => x.key === state.db);
  const pairs = MODEL.pairs.filter(p => p.dbKey === state.db);
  const usable = pairs.filter(p => metricVal(p) != null);
  if (!usable.length) {
    return '<div class="panel"><div class="empty">No successful measurements for this D1 region.</div></div>';
  }
  const ranked = usable.slice().sort((a, b) => metricVal(a) - metricVal(b));
  const winner = ranked[0];

  const scale = metricScale();
  const bars = pairBars(ranked, winner, false, scale);

  return '<div class="mapwrap full"><div class="map-name">' + dbLabelHtml(d.key) + '</div>' +
      regionMap(d, ranked, scale) + '</div>' +
    '<div class="list-title">' + dbLabelHtml(d.key) + ' to worker locations</div>' +
    '<div class="bars">' + bars + '</div>';
}

function allRegionPanel() {
  const usable = MODEL.pairs.filter(p => metricVal(p) != null);
  if (!usable.length) {
    return '<div class="panel"><div class="empty">No successful measurements.</div></div>';
  }
  const ranked = sortedPairs(usable);
  const winner = usable.slice().sort((a, b) => metricVal(a) - metricVal(b))[0];
  const scale = metricScale();
  const bars = pairBars(ranked, winner, true, scale);

  return '<div class="mapwrap full"><div class="map-name">All D1 regions</div>' +
      allRegionMap(usable, scale) + '</div>' +
    '<div class="list-title">All D1 to worker region tests</div>' +
    '<div class="bars">' + bars + '</div>';
}

function metricScale(metricKey) {
  const key = metricKey || state.metric;
  const allVals = MODEL.pairs.map(p => p[key]).filter(v => v != null);
  const gMin = allVals.length ? Math.min.apply(null, allVals) : 0;
  const gMax = allVals.length ? Math.max.apply(null, allVals) : 1;
  const sortedAll = allVals.slice().sort((a, b) => a - b);
  const q1 = quantile(sortedAll, 0.25), q3 = quantile(sortedAll, 0.75);
  const cap = q3 + 1.5 * (q3 - q1);
  const scaleMax = Math.max(gMin + 1, Math.min(gMax, cap));
  return { gMin: gMin, scaleMax: scaleMax, span: (scaleMax - gMin) || 1 };
}
function metricColor(v, scale) {
  return v > scale.scaleMax ? "#e5534b" : lerpColor(Math.min(1, (v - scale.gMin) / scale.span));
}

function pairBars(pairs, winner, includeDb, scale) {
  let bars = "";
  for (const p of pairs) {
    const v = metricVal(p);
    const over = v > scale.scaleMax;
    const w = over ? 100 : Math.max(2, (v / scale.scaleMax) * 100);
    const t = Math.min(1, (v - scale.gMin) / scale.span);
    const col = lerpColor(t);
    const isBest = p === winner;
    const name = includeDb ? dbLabelText(p.dbKey) + " → " + placementLabelText(p) : placementLabelText(p);
    const nameHtml = includeDb ? dbLabelHtml(p.dbKey) + " → " + placementLabelHtml(p) : placementLabelHtml(p);
    const fillStyle = over ? 'width:100%' : 'width:' + w + '%;background:' + col;
    const fillInner = over ? '<span class="over-label">off scale &#8250;&#8250;</span>' : '';
    bars += '<div class="barrow ' + (isBest ? "best" : "") + '">' +
      '<div class="name" title="' + esc(name) + '">' + nameHtml + '</div>' +
      '<div class="track"><div class="fill' + (over ? " over" : "") + '" style="' + fillStyle + '"' +
        (over ? ' title="off scale (above ' + fmt(scale.scaleMax) + ')"' : '') + '>' + fillInner + '</div></div>' +
      '<div class="val' + (over ? " over-val" : "") + '"><span class="num">' + fmtNum(v) + '</span><span class="u">ms</span></div>' +
    '</div>';
  }
  return bars;
}

// World map for one D1: the region marker plus an arc to every observed Worker placement colo.
function regionMap(d, ranked, scale) {
  const B = MODEL.basemap;
  if (!B) return '<div class="empty">No basemap available.</div>';
  const W = B.w, H = B.h;
  const d1ll = dbCoord(d.key);
  let land = "";
  for (const path of B.paths) land += '<path class="mland" d="' + path + '"/>';
  // Crop the empty polar bands (above ~80°N / below ~58°S) so the full-width
  // map isn't needlessly tall; every data city sits inside this band.
  const yTop = (90 - 80) / 180 * H, yBot = (90 + 58) / 180 * H;
  const vb = "0 " + yTop.toFixed(1) + " " + W + " " + (yBot - yTop).toFixed(1);
  if (!d1ll) return '<svg class="regionmap" viewBox="' + vb + '"><g>' + land + '</g></svg>';
  const d1pt = projXY(d1ll[0], d1ll[1], W, H);
  let arcs = "", dots = "";
  for (const p of ranked) {
    const c = observedPlaceCoord(p);
    if (!c) continue;
    const pt = projXY(c[0], c[1], W, H);
    const v = metricVal(p);
    const col = metricColor(v, scale);
    arcs += '<path class="marc" d="' + arcPath(d1pt, pt) + '" stroke="' + col + '"></path>';
    dots += '<circle class="mw" cx="' + pt[0].toFixed(1) + '" cy="' + pt[1].toFixed(1) +
      '" r="7" fill="' + col + '" data-ms="' + fmtNum(v) + '" data-loc="' + esc(placementLabelText(p)) +
      '" data-loc-html="' + esc(placementLabelHtml(p)) + '"></circle>';
  }
  dots += '<circle class="md1halo" cx="' + d1pt[0].toFixed(1) + '" cy="' + d1pt[1].toFixed(1) + '" r="22"></circle>' +
    '<circle class="md1" cx="' + d1pt[0].toFixed(1) + '" cy="' + d1pt[1].toFixed(1) + '" r="11">' +
    '<title>D1 ' + esc(dbLabelText(d.key)) + '</title></circle>';
  return '<svg class="regionmap" viewBox="' + vb + '" preserveAspectRatio="xMidYMid meet">' +
    '<g>' + land + '</g>' + arcs + dots + '</svg>';
}

// World map for all D1 regions: every D1 marker plus every D1-to-observed-Worker-colo line.
function allRegionMap(pairs, scale) {
  const B = MODEL.basemap;
  if (!B) return '<div class="empty">No basemap available.</div>';
  const W = B.w, H = B.h;
  let land = "";
  for (const path of B.paths) land += '<path class="mland" d="' + path + '"/>';
  const yTop = (90 - 80) / 180 * H, yBot = (90 + 58) / 180 * H;
  const vb = "0 " + yTop.toFixed(1) + " " + W + " " + (yBot - yTop).toFixed(1);
  let arcs = "", dots = "", d1s = "";
  const byPlacement = {};
  for (const p of pairs) {
    const d1ll = dbCoord(p.dbKey);
    const c = observedPlaceCoord(p);
    if (!d1ll || !c) continue;
    const d1pt = projXY(d1ll[0], d1ll[1], W, H);
    const pt = projXY(c[0], c[1], W, H);
    const v = metricVal(p);
    const col = metricColor(v, scale);
    arcs += '<path class="marc" d="' + arcPath(d1pt, pt) + '" stroke="' + col + '"></path>';
    if (!byPlacement[p.placement]) {
      byPlacement[p.placement] = { placement: p.placement, pt: pt, values: [], placementColos: {}, noteCounts: {} };
    }
    mergePairColos(byPlacement[p.placement], p);
    byPlacement[p.placement].values.push({ dbKey: p.dbKey, placement: p.placement, value: v });
  }
  for (const entry of Object.values(byPlacement)) {
    entry.values.sort((a, b) => a.value - b.value);
    const avg = entry.values.reduce((sum, item) => sum + item.value, 0) / entry.values.length;
    const col = metricColor(avg, scale);
    const c = observedPlaceCoord(entry);
    if (c) entry.pt = projXY(c[0], c[1], W, H);
    const tipRows = entry.values.map(item => ({
      dbKey: item.dbKey,
      value: fmtNum(item.value),
    }));
    dots += '<circle class="mw" cx="' + entry.pt[0].toFixed(1) + '" cy="' + entry.pt[1].toFixed(1) +
      '" r="6.5" fill="' + col + '" data-region="' + esc(placementLabelText(entry)) +
      '" data-region-html="' + esc(placementLabelHtml(entry)) + '" data-list="' +
      esc(JSON.stringify(tipRows)) + '"></circle>';
  }
  for (const d of MODEL.databases) {
    const d1ll = dbCoord(d.key);
    if (!d1ll) continue;
    const pt = projXY(d1ll[0], d1ll[1], W, H);
    d1s += '<circle class="md1halo" cx="' + pt[0].toFixed(1) + '" cy="' + pt[1].toFixed(1) + '" r="20"></circle>' +
      '<circle class="md1" cx="' + pt[0].toFixed(1) + '" cy="' + pt[1].toFixed(1) + '" r="9">' +
      '<title>D1 ' + esc(dbLabelText(d.key)) + '</title></circle>' +
      '<text class="md1label" x="' + (pt[0] + 14).toFixed(1) + '" y="' + (pt[1] - 12).toFixed(1) + '">' +
      dbSvgLabel(d.key) + '</text>';
  }
  return '<svg class="regionmap" viewBox="' + vb + '" preserveAspectRatio="xMidYMid meet">' +
    '<g>' + land + '</g>' + arcs + dots + d1s + '</svg>';
}

function wire() {
  // Global metric ("P") filter — re-renders cards and the stats below.
  document.querySelectorAll("[data-metric]").forEach(t => {
    t.onclick = () => { state.metric = t.getAttribute("data-metric"); render(); };
  });
  wireRegionPanel();
  // Clicking a map card selects that D1 region for the stats below.
  document.querySelectorAll(".v12card[data-db]").forEach(c => {
    const pick = () => {
      const db = c.getAttribute("data-db");
      state.db = state.db === db ? "all" : db;
      state.sort = "metric";
      state.dir = 1;
      syncMapCardSelection();
      renderRegionPanel();
    };
    c.onclick = pick;
    c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  });
  document.querySelectorAll("th[data-msort]").forEach(th => {
    th.onclick = () => {
      const key = th.getAttribute("data-msort");
      if (state.matrixSort === key) state.matrixDir *= -1;
      else { state.matrixSort = key; state.matrixDir = 1; }
      render();
    };
  });
}

function wireRegionPanel() {
  // Custom tooltip for worker dots on the map.
  const map = document.querySelector(".regionmap");
  const tip = document.getElementById("maptip");
  if (map && tip) {
    const msEl = tip.querySelector(".maptip-ms"), locEl = tip.querySelector(".maptip-loc");
    map.addEventListener("mousemove", (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains("mw")) {
        const list = t.getAttribute("data-list");
        if (list) {
          let rows = [];
          try { rows = JSON.parse(list); } catch (error) {}
          msEl.innerHTML = t.getAttribute("data-region-html") || esc(t.getAttribute("data-region") || "Worker region");
          locEl.innerHTML = '<div class="maptip-list">' + rows.map(row =>
            '<div class="maptip-row">' +
              '<span class="maptip-d1">' + dbLabelHtml(row.dbKey) + '</span>' +
              '<span class="maptip-value">' + esc(row.value) + '<span class="u">ms</span></span>' +
            '</div>'
          ).join("") + '</div>';
        } else {
          msEl.innerHTML = t.getAttribute("data-ms") + '<span class="u">ms</span>';
          locEl.innerHTML = t.getAttribute("data-loc-html") || esc(t.getAttribute("data-loc"));
        }
        tip.hidden = false;
        const w = tip.offsetWidth || 120;
        const h = tip.offsetHeight || 80;
        let x = e.clientX + 14;
        if (x + w > window.innerWidth - 8) x = e.clientX - 14 - w;
        let y = e.clientY + 16;
        if (y + h > window.innerHeight - 8) y = e.clientY - 16 - h;
        tip.style.left = x + "px";
        tip.style.top = Math.max(8, y) + "px";
      } else {
        tip.hidden = true;
      }
    });
    map.addEventListener("mouseleave", () => { tip.hidden = true; });
  }
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.onclick = () => {
      const key = th.getAttribute("data-sort");
      if (state.sort === key) state.dir *= -1;
      else { state.sort = key; state.dir = 1; }
      renderRegionPanel();
    };
  });
}

Site.initTheme();
Site.setAppClass("wrap");
render();
