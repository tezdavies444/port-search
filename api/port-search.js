// TAD Cruise — Port Search API (Vercel serverless function)
// ---------------------------------------------------------------------------
// Holds the Airtable token SERVER-SIDE so it is never exposed to the browser.
// The static page (index.html) calls this endpoint; the token stays in an
// environment variable on Vercel and is never shipped to the client.
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
// ---------------------------------------------------------------------------

const BASE_ID = "app0m26JOCMpY9CCf";
const ENGAGEMENTS_TABLE = "tbl4fM83A4lecUsOK";
const PORTS_TABLE = "tbltnDPv5RkJdx8R1";

// Field IDs (stable even if a field is renamed in Airtable).
const F = {
  artist:        "fldUvZAMFzvvQ8uUD", // ARTIST (linked) -> clean act name
  details:       "fldoVJlhyYJ6vK3Gr", // "Act Name - Genre" (fallback)
  ship:          "fldfPJDNDOsdMLoeP", // SHIP (linked)
  embarkDate:    "fld3ubYPBEOMabtYH", // DATE FROM
  debarkDate:    "fldgBJLcQVkOaaCNo", // DATE TO
  embarkPort:    "fldEDah9GmqCWIzVm", // Embark Port - Link
  disembarkPort: "fldRxIT5RfBfpA3XN", // Disembark Port - Link
  status:        "fldMs85bDLV5PMisH", // STATUS
};

// Field NAMES used inside filterByFormula (formulas cannot reference field IDs).
const FN = {
  debarkDate:    "DATE TO",
  embarkPort:    "Embark Port - Link",
  disembarkPort: "Disembark Port - Link",
};

const PORT_NAME_FIELD = "Port Name";

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
    err.detail = text.slice(0, 300);
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

function linkName(cell) {
  return Array.isArray(cell) && cell[0] ? cell[0].name : "";
}

function actName(fields) {
  const fromLink = linkName(fields[F.artist]);
  if (fromLink) return fromLink;
  const details = fields[F.details] || "";
  return details.split(" - ")[0].trim() || details.trim();
}

// Keep only characters that can appear in a port name; prevents formula breakage.
function sanitizePort(q) {
  return String(q || "")
    .replace(/["\\]/g, " ")          // drop quotes/backslashes (we quote with ")
    .replace(/[^\p{L}\p{N}\s().,&'\-/]/gu, " ")
    .trim()
    .slice(0, 80);
}

async function handlePorts(res) {
  const records = await listAll(PORTS_TABLE, {
    "fields[]": [PORT_NAME_FIELD],
    pageSize: 100,
  });
  const names = [...new Set(
    records.map((r) => (r.fields[PORT_NAME_FIELD] || "").trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
  send(res, 200, { ports: names });
}

async function handleSearch(res, rawPort) {
  const port = sanitizePort(rawPort);
  if (port.length < 2) return send(res, 400, { error: "Enter at least 2 characters." });

  const needle = port.toLowerCase();
  // Future = engagement not yet ended (debark today or later).
  // Port match = case-insensitive substring on either linked port field.
  const formula =
    `AND(` +
      `IS_AFTER({${FN.debarkDate}}, DATEADD(TODAY(), -1, 'days')),` +
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

  const rows = records.map((r) => {
    const f = r.fields;
    const embarkPort = linkName(f[F.embarkPort]);
    const disembarkPort = linkName(f[F.disembarkPort]);
    const isEmbark = embarkPort.toLowerCase().includes(needle);
    const isDebark = disembarkPort.toLowerCase().includes(needle);
    return {
      id: r.id,
      act: actName(f),
      ship: linkName(f[F.ship]),
      embarkDate: f[F.embarkDate] || null,
      debarkDate: f[F.debarkDate] || null,
      embarkPort,
      disembarkPort,
      status: f[F.status]?.name || "",
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

    // Optional shared-code staff gate.
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
    const status = e.status === 401 || e.status === 403 ? 502 : 500;
    send(res, status, { error: "Lookup failed.", detail: e.detail || e.message });
  }
};
