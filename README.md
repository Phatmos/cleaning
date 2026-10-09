# Yellowstone Renovation — Onsite Sales & Deck Estimator

A tablet-first app for onsite deck sales in Central Kentucky. It has two connected modes that work on the same saved estimate:

1. **With customer**: an illustrated consultation. Project type, wood vs. composite, brands, colors, shape, picture frame, fascia, railing, gates, stairs, upgrades, photos and notes. Every tap is saved right away.
2. **Measure & build**: the technical estimate. A 2D deck sketch editor, structure, footings, decking, railing, stairs, demolition and site, then a review of a traceable bill of materials and the price.

After that the app creates a frozen proposal, which the salesman can send by email or show as a QR code. The customer can approve it. Only then can it be converted to a contract, and only after a verified signature does it queue a hand-off to Zoho Projects.

## Quick start

```bash
npm install
npm run build                 # builds the web app into dist/
npm run seed:demo             # OPTIONAL: fictitious DEMO data (see below)
npm start                     # http://localhost:3001
```

For development, run `npm run dev`. It starts the API on :3001 and Vite on :5173, with `/api` proxied to the API.

On first start the server creates an admin account and prints its password. You can set `ADMIN_EMAIL` and `ADMIN_PASSWORD` to choose them. Data is stored in `data/yellowstone.db` (SQLite through Node's built-in `node:sqlite`; Node ≥ 22.13), and uploads go in `data/uploads/`. Set `DATA_DIR` to store them somewhere else.

### Demo data

`npm run seed:demo` loads three demo users (`sales@demo.local / demo-sales-1`, `manager@demo.local / demo-manager-1`, `admin@demo.local / demo-admin-1`), three customers with visits, and a catalog whose items are **all flagged DEMO**. The products ("DEMO Composite Co.", "DEMO Aluminum Rail", …) and prices are fictitious. An estimate that uses demo items can never be sent. No structural rules are seeded.

## Deploy (make it live)

The app is one container: the API and the built web app, with SQLite on a persistent disk. It needs a host with a **persistent volume** (Netlify alone can't run it; Netlify suits static sites).

**Render (simplest)**
1. Put this code in a GitHub repo you own.
2. In Render, choose **New › Blueprint** and pick the repo. `render.yaml` creates the web service and a 5 GB disk mounted at `/data`.
3. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `PUBLIC_BASE_URL` (the site's https address, used for QR codes and email links).
4. After the first deploy, load the price books. Either use Admin › Price lists, or open a Render shell and run `npm run import:pricebook -- <files>`.

**Any Docker host** (Fly.io, Railway, a VPS):
`docker build -t yellowstone . && docker run -p 3001:3001 -v yellowstone-data:/data -e ADMIN_EMAIL=… -e ADMIN_PASSWORD=… -e PUBLIC_BASE_URL=https://… yellowstone`

`GET /api/health` reports `{ ok, version }`. Back up `/data` (`yellowstone.db` + `uploads/`). Optional integrations are enabled with the environment variables in `.env.example`.

## Yellowstone Leap price books

Admin › Price lists recognizes the Leap formats automatically:

- **Material book** (`Yellowstone_Leap_Material_Pricebook_2026.xlsx`; the "Master Catalog" sheet is preferred, otherwise "Leap Import"). 657 SKUs.
- **Labor book** (`Yellowstone_Leap_Labor_Pricebook.xls`). 152 items.

For a first load you can also use the command line:

```bash
npm run import:pricebook -- path/to/Material_Pricebook.xlsx path/to/Labor_Pricebook.xls
```

How the books are mapped:

- **Prices.** *Unit Cost* becomes cost and *Selling Price* becomes a fixed sell price. Per the Setup Guide, that is cost + 10% for materials; for labor it is the book's own price.
- **Read from the file text.** Stock lengths ("1x6x16 ft"), fascia/riser height ("1/2x12x12 ft"), box counts ("90 ct"), rail-kit length ("6 ft x 36 in", used as the maximum post spacing; *verify*) and lumber sizes. Each derived value is noted in the import report.
- **Not guessed.** Actual board width, board gap, max joist spacing, clips per joist crossing and concrete yield are not in the books. **Admin › Product specs** lists every product line still missing them (27 after importing both books). Enter each once from the manufacturer's install guide and record the source.
- **Labor selection.** Labor is picked by **item name** using `laborMap` (Admin › Settings): the deck height tier (Up to 6 ft / 7-18 ft / 19 ft Plus), joist size and spacing, stair width band, and the railing system. A missing or unmapped item is reported as a blocker, never substituted. Composite railing systems (Trex Select, TimberTech Classic/Impression) have no matching labor item in the book, so map them in `laborMap.railingBySystem`.
- **Railing posts** are matched to rail systems by brand only, which shows a "confirm compatibility" note. The book has no deck railing **gate** kits, so a gate shows "needs product" until one is added.
- **Pricing policy.** Project markup % and commission % are separate settings, both 0% until you confirm them. The handoff mentions 25% / 10% as historical assumptions.
- **Rollback.** Each import can be rolled back. Updated items revert; new items are deactivated, never deleted, because sent proposals may reference them.
- **Added items.** On Review, the "Added items" section adds any price-book item the calculator doesn't place automatically (joist tape, RainEscape, lattice, dumpster, delivery…). Free-priced lines are for managers only. The material list downloads as CSV.

## Tests

```bash
npm test        # 56 tests: calculation engine + API/persistence
npm run typecheck
```

The acceptance fixtures in `tests/engine.test.ts` cover:

- 16 × 20 = exactly 320 sq ft, plus unit parsing and fractional inches
- a rectangle + triangle, overlapping areas and shared edges that don't inflate area, perimeter or railing
- the 20 ft / 16" joist fixture giving 16 base lines, with rims and extra framing kept separate
- railing on a deck attached on one side, with gate and stair openings and shared corner posts counted once
- picture frame, fascia, direction, stock length and pack size changes
- incompatible railing parts are blocked
- stair and footing concrete math traced to inputs and product yield
- missing inputs, overspans, brick-veneer ledgers and missing prices block completion
- overrides are preserved across recalculation
- wood and composite options priced from the same geometry

`tests/api.test.ts` covers:

- persistence and exact resume
- multi-device conflict detection (409)
- role-restricted price overrides and discounts
- photo-upload retry dedupe
- idempotent sending (one email, one `EstimateSent` event)
- revisions locked after a send
- frozen proposal prices after a catalog change
- the public link exposing no cost, margin or other customers
- approval ≠ signed contract
- an idempotent hand-off
- price-list import with mapping, validation and admin approval

## Architecture

```
src/engine/     Pure TypeScript, deterministic, runs in browser and server
  units.ts        inches internally; parse/format feet-inches with fractions
  geometry.ts     shapes → polygons, validation (self-intersection), union/cutouts
                  (polygon-clipping), shoelace area, edge mapping, arc approximation
  framing.ts      joist lines ceil(W/s)+1, joist cut list, rims/ledger/extra framing,
                  beams/posts from the actual layout, span checks vs. VERIFIED rules only
  decking.ts      board rows by strip clipping, picture frame, fascia, exact joist crossings
  allocate.ts     documented first-fit-decreasing stock allocation (not claimed optimal)
  railing.ts      runs from tagged edges minus openings, sections per leg, shared posts
  stairs.ts       risers/treads/run/stringers + footing concrete volume → bags
  pricing.ts      markup vs. margin (distinct formulas), needs-pricing (never $0), tax
  estimate.ts     assembles traceable BOM lines (inputs, formula, rule ref, rounding,
                  source version, override) per alternative
src/server/     Express API, SQLite, roles, revisions, import, proposals, outbox
src/web/        React UI (Apple-style), IndexedDB offline drafts + photo queue
```

How the main guarantees are enforced:

- **Persistence.** Every edit is written to IndexedDB first, then autosaved with the revision's base version. The UI shows *Saving / Saved hh:mm / Offline — saved on this device / Sync failed / Needs your decision*. "Saved" appears only after the server acknowledges the save. A newer save from another device opens an explicit conflict dialog. Refreshing returns you to the exact mode and step.
- **Upstream changes.** If you deselect a brand or turn off fascia, the dependent options are *flagged for review*, never deleted.
- **Revisions.** Sending a proposal locks its revision. Further changes need a new revision, so a sent proposal and a signed contract are never overwritten.
- **Proposals** snapshot the calculated result, the catalog version and the rule version. The public link (`/p/<random token>`) returns only the customer-safe projection. Viewing it never triggers workflow events.
- **Outbox.** `EstimateSent` (v1) is created **only** after an email provider accepts the send. It is deduped per estimate (configurable). Events that come from Zoho are never echoed back to Zoho.

## What is operational vs. not connected

| Area | State |
|---|---|
| Consultation, sketch editor, calculator, BOM, pricing, review | **Working** |
| Persistence, offline drafts, conflicts, revisions, audit log | **Working** |
| Roles (admin / manager / salesman) and assignment checks | **Working** |
| Price-list import (CSV/XLSX → map → validate → approve) | **Working** |
| Product image catalog with source/permission metadata | **Working** (no images included) |
| Proposal snapshot, PDF, public link, QR, customer approval | **Working** |
| Convert to contract (template, tracked edits, missing-field markers) | **Working** |
| Email sending | **Interface ready, not connected.** Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM`. Until then, sends are refused and recorded as "not sent". |
| Zoho CRM (appointments in, stage pushes out) | **Client written, not connected or tested.** Set `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` (and `ZOHO_API_DOMAIN`/`ZOHO_ACCOUNTS_URL` outside the US), then confirm the stage mapping in Admin › Settings. Events wait in the outbox until then. |
| Zoho Projects hand-off | **Queued and idempotent, not connected.** Needs `ZOHO_PROJECTS_PORTAL_ID`. |
| E-signature | **Not connected.** A manager records the signed copy by uploading it. |
| SMS follow-ups | **Configuration only.** No provider; nothing is ever sent. |
| AI photo assistant (optional) | **Off** until `ANTHROPIC_API_KEY` is set. Suggestions need human confirmation. |

## Inputs still needed from Yellowstone

These were checked in the Zoho CRM account (read-only) on 2026-10-09. None of them are guessed in the app:

1. **Product install specs** for the 27 product lines listed in Admin › Product specs. The Leap books (received 2026-10-09) supply SKUs and prices; actual board width, gap, joist spacing, clips per crossing and concrete yield must come from the manufacturers' install guides.
2. **Structural rules.** Joist and beam span tables, stair limits, guard thresholds and ledger fastening for the code edition adopted by Lexington-Fayette, each verified by a named reviewer (**Admin › Structural rules**). Until a verified set is active, every estimate shows "not structurally verified" and cannot be finalized.
3. **Sales-tax treatment.** Have your accountant verify it, then enter it in **Admin › Settings**. Until then, final totals are blocked.
4. **Labor mapping gaps.** Pick labor items for the composite railing systems and confirm the height-tier boundaries in `laborMap`. Deck railing gate kits are missing from the material book.
5. **Product images** from Trex, TimberTech or other manufacturers, using assets you are authorized to use. Upload them with their source URL and permission status. Cards show labeled placeholders until then.
6. **Contract template legal terms**, payment terms and warranty text. These must be attorney-approved; the template skeleton contains an `[ADMIN: …]` placeholder that blocks sending.
7. **Zoho pipeline confirmation.** The stage names were read from the Deals "Stage" picklist and include *Appointment Scheduled, Estimate in Progress, Estimate Sent, Follow Up, Contract Signed*. Confirm which of them belong to the *Yellowstone Renovation Sales* pipeline before you enable stage sync.
