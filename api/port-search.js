// TAD Cruise — Port Search API (Vercel serverless function)
// ---------------------------------------------------------------------------
// Holds the Airtable token SERVER-SIDE so it is never exposed to the browser.
//
// Required environment variable:
//   AIRTABLE_PAT        Airtable personal access token, scoped read-only to
//                       the Cruise Engagements base (data.records:read).
//
// Optional environment variable (staff gate):
//   STAFF_ACCESS_CODE   If set, requests must send a matching code via the
//                       `x-staff-code` header (or ?code=). If unset, no code
//                       is required (rely on Vercel/Softr auth instead).
//
// Endpoints:
//   GET /api/port-search?action=ports
//   GET /api/port-search?action=search&port=<text>
//
// Note on linked fields: Airtable's REST API returns linked-record cells as
// arrays of record IDs (not names), so act/ship/port names are resolved with a
// follow-up lookup against their tables. (The code also accepts already-named
// cells, in case the API returns those.)
// ---------------------------------------------------------------------------

const BASE_ID = "app0m26JOCMpY9CCf";
const ENGAGEMENTS_TABLE = "tbl4fM83A4lecUsOK";
const PORTS_TABLE = "tbltnDPv5RkJdx8R1";
const SHIPS_TABLE = "tblK3F0mCpHqD8gz1";

// Field IDs on ENGAGEMENTS (stable even if a field is renamed in Airtable).
const F = {
  details:       "fldoVJlhyYJ6vK3Gr", // "Act Name - Genre" (primary, formula)
  ship:          "fldfPJDNDOsdMLoeP", // CRUISE SHIP (link)
  embarkDate:    "fld3ubYPBEOMabtYH", // DATE FROM
  debarkDate:    "fldgBJLcQVkOaaCNo", // DATE TO
  embarkPort:    "fldEDah9GmqCWIzVm", // Embark Port - Link
  disembarkPort: "fldRxIT5RfBfpA3XN", // Disembark Port - Link
  status:        "fldMs85bDLV5PMisH", // STATUS (single select)
};

// Field NAMES used inside filterByFormula (formulas cannot reference field IDs).
const FN = {
  status:        "STATUS",
  debarkDate:    "DATE TO",
  embarkPort:    "Embark Port - Link",
  disembarkPort: "Disembark Port - Link",
};

// Engagement statuses treated as "confirmed" (exact single-select option names).
const CONFIRMED_STATUSES = ["Confirmed", "Changed/Confirmed"];

// Primary-field IDs used to resolve linked record names.
const PORT_NAME_FIELD_ID = "fldqxwoNvUnGXaTIN"; // Ports → "Port Name"
const SHIP_NAME_FIELD_ID = "fldMlD82a9Whm72a4"; // SHIPS → "Name"
const PORT_NAME_FIELD = "Port Name";            // for the ports autocomplete

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function airtable(path, params) {
  const url = new URL(`https://api.airtable.com/v0/${path}`);
  if (params) for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const err = new Error(`Airtable ${r.status}`);
    err.status = r.status;
    err.detail = `Airtable ${r.status}: ${text.slice(0, 250)}`;
    throw err;
  }
  return r.json();
}

// Fetch every page of a table query.
async function listAll(table, params) {
  const records = [];
  let offset;
  do {
    const page = await airtable(`${BASE_ID}/${table}`, { ...params, offset });
    records.push(...(page.records || []));
    offset = page.offset;
  } while (offset);
  return records;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Pull linked record IDs from a cell, whether it's ["recX"] or [{id:"recX"}].
function linkedIds(cell) {
  if (!Array.isArray(cell)) return [];
  return cell
    .map((v) => (typeof v === "string" ? v : v && typeof v === "object" && v.id ? v.id : null))
    .filter(Boolean);
}

// Resolve a linked cell to a display name: use an inline name if present,
// otherwise look it up in the provided id→name map.
function resolveLink(cell, map) {
  if (!Array.isArray(cell) || !cell.length) return "";
  const v = cell[0];
  if (v && typeof v === "object" && v.name) return v.name;
  const id = typeof v === "string" ? v : v && v.id ? v.id : null;
  return (id && map[id]) || "";
}

// Build an id→name map for a set of linked record IDs.
async function resolveNames(table, ids, nameFieldId) {
  const map = {};
  const unique = [...new Set(ids)];
  for (const group of chunk(unique, 50)) {
    if (!group.length) continue;
    const formula = "OR(" + group.map((id) => `RECORD_ID()='${id}'`).join(",") + ")";
    const recs = await listAll(table, {
      filterByFormula: formula,
      returnFieldsByFieldId: "true",
      "fields[]": [nameFieldId],
      pageSize: 100,
    });
    recs.forEach((r) => { map[r.id] = r.fields[nameFieldId] || ""; });
  }
  return map;
}

function statusText(cell) {
  if (!cell) return "";
  if (typeof cell === "string") return cell;          // raw REST single-select
  if (typeof cell === "object" && cell.name) return cell.name; // enriched
  return "";
}

function actName(fields) {
  const details = fields[F.details] || "";
  return details.split(" - ")[0].trim() || details.trim();
}

// Keep only characters that can appear in a port name; prevents formula breakage.
function sanitizePort(q) {
  return String(q || "")
    .replace(/["\\]/g, " ")
    .replace(/[^\p{L}\p{N}\s().,&'\-/]/gu, " ")
    .trim()
    .slice(0, 80);
}

async function handlePorts(res) {
  const records = await listAll(PORTS_TABLE, { "fields[]": [PORT_NAME_FIELD], pageSize: 100 });
  const names = [...new Set(
    records.map((r) => (r.fields[PORT_NAME_FIELD] || "").trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
  send(res, 200, { ports: names });
}

async function handleSearch(res, rawPort) {
  const port = sanitizePort(rawPort);
  if (port.length < 2) return send(res, 400, { error: "Enter at least 2 characters." });

  const needle = port.toLowerCase();
  const statusClause =
    "OR(" + CONFIRMED_STATUSES.map((s) => `{${FN.status}}='${s}'`).join(",") + ")";
  const formula =
    `AND(` +
      `IS_AFTER({${FN.debarkDate}}, DATEADD(TODAY(), -1, 'days')),` +
      statusClause + `,` +
      `OR(` +
        `FIND("${needle}", LOWER(ARRAYJOIN({${FN.embarkPort}}, ", "))),` +
        `FIND("${needle}", LOWER(ARRAYJOIN({${FN.disembarkPort}}, ", ")))` +
      `)` +
    `)`;

  const records = await listAll(ENGAGEMENTS_TABLE, {
    filterByFormula: formula,
    returnFieldsByFieldId: "true",
    "fields[]": Object.values(F),
    pageSize: 100,
  });

  // Collect linked IDs that need name resolution.
  const portIds = [];
  const shipIds = [];
  records.forEach((r) => {
    const f = r.fields;
    linkedIds(f[F.embarkPort]).forEach((id) => portIds.push(id));
    linkedIds(f[F.disembarkPort]).forEach((id) => portIds.push(id));
    linkedIds(f[F.ship]).forEach((id) => shipIds.push(id));
  });

  const portMap = portIds.length ? await resolveNames(PORTS_TABLE, portIds, PORT_NAME_FIELD_ID) : {};
  const shipMap = shipIds.length ? await resolveNames(SHIPS_TABLE, shipIds, SHIP_NAME_FIELD_ID) : {};

  const rows = records.map((r) => {
    const f = r.fields;
    const embarkPort = resolveLink(f[F.embarkPort], portMap);
    const disembarkPort = resolveLink(f[F.disembarkPort], portMap);
    const isEmbark = embarkPort.toLowerCase().includes(needle);
    const isDebark = disembarkPort.toLowerCase().includes(needle);
    return {
      id: r.id,
      act: actName(f),
      ship: resolveLink(f[F.ship], shipMap),
      embarkDate: f[F.embarkDate] || null,
      debarkDate: f[F.debarkDate] || null,
      embarkPort,
      disembarkPort,
      status: statusText(f[F.status]),
      direction: isEmbark && isDebark ? "both" : isEmbark ? "embark" : "debark",
    };
  }).sort((a, b) => (a.embarkDate || "").localeCompare(b.embarkDate || ""));

  send(res, 200, { port, count: rows.length, rows });
}

module.exports = async (req, res) => {
  try {
    if (!process.env.AIRTABLE_PAT) {
      return send(res, 500, { error: "Server is missing AIRTABLE_PAT. Set it in Vercel env vars." });
    }

    const required = process.env.STAFF_ACCESS_CODE;
    if (required) {
      const given = req.headers["x-staff-code"] ||
        new URL(req.url, "http://x").searchParams.get("code") || "";
      if (given !== required) return send(res, 401, { error: "unauthorized" });
    }

    const q = new URL(req.url, "http://x").searchParams;
    const action = q.get("action") || "search";

    if (action === "ports") return await handlePorts(res);
    if (action === "search") return await handleSearch(res, q.get("port"));
    return send(res, 400, { error: "Unknown action." });
  } catch (e) {
    send(res, 500, { error: "Lookup failed.", detail: e.detail || e.message });
  }
};
