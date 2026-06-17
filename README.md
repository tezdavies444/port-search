# TAD Cruise — Port Search (staff tool)

Type a port, get every **confirmed, upcoming** engagement that embarks or
debarks there: act name, ship, and embark → debark dates. Reads live from the
Cruise Engagements base. Results can be exported to CSV (the **Download CSV**
button appears once you have results and exports exactly what's shown).

## Files
- `index.html` — the staff-facing page. No token inside it.
- `api/port-search.js` — serverless function that talks to Airtable. The token
  lives here, server-side, as an environment variable.

## Why it's built this way (and not as one HTML file)
A single HTML file with the Airtable token inside it is fine for a dashboard
*you* open, but it can't be "staff only": anyone who gets the URL can read the
token straight out of the browser, and that token can read the whole base. So
the token is kept on the server, and the page just calls the function. This is
the part that actually makes it safe to share with the team.

## Deploy (Vercel — same flow as your other tools)
1. Drop this folder into a new Vercel project (or a subfolder of an existing
   one). Vercel auto-detects `api/port-search.js` as a function.
2. Add an environment variable:
   - `AIRTABLE_PAT` — an Airtable personal access token scoped **read-only**
     (`data.records:read`) to the Cruise Engagements base only. Don't reuse a
     broad token here; mint a narrow one for this tool.
3. (Recommended) Add a staff gate — pick one:
   - **Access code:** set `STAFF_ACCESS_CODE` to a shared phrase. The page asks
     for it once and remembers it for the session. Simple, good enough for an
     internal link.
   - **Vercel Authentication / SSO:** turn on Vercel's password or SSO
     protection for the deployment. Strongest option, no code in the app.
   - **Embed in Cruise Avails / Softr:** if you'd rather it live behind the
     login you already have, host the function on a TAD subdomain and drop the
     page into Cruise Avails as an embed. The function URL is the only thing the
     page needs.
4. Deploy. Visit the URL, search a port.

## How it decides what to show
- **Upcoming only:** an engagement appears while its debark date is today or
  later. Anything fully in the past is excluded.
- **Port match:** case-insensitive, matches on either the Embark or Disembark
  linked-port field. Each row is tagged "Embarks here" / "Debarks here".
- **Confirmed only:** only engagements with STATUS `Confirmed` or
  `Changed/Confirmed` are returned. Available holds, Pending, Offered,
  Cancelled, Completed, etc. are excluded server-side. (To match strictly
  `Confirmed`, remove `Changed/Confirmed` from `CONFIRMED_STATUSES` in the
  function.)
- **Ship:** shows "not yet assigned" when no ship is linked yet (common on
  availability holds before a contract firms up).

## Field mapping (Cruise Engagements base `app0m26JOCMpY9CCf`)
Referenced by field ID so renames in Airtable won't break it.

| Shown as        | Field                | ID                      |
|-----------------|----------------------|-------------------------|
| Act             | ARTIST (linked)      | `fldUvZAMFzvvQ8uUD`     |
| Ship            | SHIP (linked)        | `fldfPJDNDOsdMLoeP`     |
| Embark date     | DATE FROM            | `fld3ubYPBEOMabtYH`     |
| Debark date     | DATE TO              | `fldgBJLcQVkOaaCNo`     |
| Embark port     | Embark Port - Link   | `fldEDah9GmqCWIzVm`     |
| Disembark port  | Disembark Port - Link| `fldRxIT5RfBfpA3XN`     |
| Status          | STATUS               | `fldMs85bDLV5PMisH`     |

Note: this finds acts that **join or leave** a ship at the port. It does not
find ships that merely *call* at the port mid-voyage — the base stores each
engagement's embark/disembark ports, not the full itinerary.
