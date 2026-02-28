# Nuffield Health Gym Landing Page Audit

Automated review of Nuffield Health gym landing pages against three criteria:

1. Clear on facilities available
2. Modern / appealing imagery
3. Clear call to action to join online

## What this produces

- `data/audit-report.json`: full machine-readable output
- `data/audit-report.csv`: tabular output for spreadsheets
- `docs/index.html`: Nuffield-branded website report (static)

## Method summary

- Source URLs: `https://www.nuffieldhealth.com/sitemap_gyms.xml`
- Candidate selection: top-level `/gyms/{slug}` pages
- Non-club pages excluded (membership hubs, closures, promo pages)
- Each included page scored Pass/Fail for all 3 criteria with evidence

Scoring heuristics:

- Facilities clarity: explicit facilities/amenities context and >=10 facility terms found on page
- Modern imagery: enough meaningful non-logo images and modern delivery signals (webp/avif or lazy loading)
- Join CTA clarity: visible join/membership CTA with online membership/join destination signals

## Run locally

```bash
npm install
npm run audit
```

### Optional: Google profile enrichment

To populate Google review/profile columns, set a Google Places API key first:

```bash
# PowerShell
$env:GOOGLE_PLACES_API_KEY="your_api_key_here"
npm run audit
```

Without this key, Google columns are shown as unavailable.

## Preview the website

```bash
npm run serve
```

Then open `http://localhost:4173`.

## Publish externally

Any static host works with the generated `docs/` folder.

- GitHub Pages: publish `docs/` from your repo branch
- Netlify: deploy `docs/` as a static site
- Azure Static Web Apps / Cloudflare Pages: point build output to `docs/`

## Refresh cadence

Re-run `npm run audit` whenever you want a current snapshot against live pages.
