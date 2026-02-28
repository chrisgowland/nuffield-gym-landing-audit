const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'docs');
const DATA_DIR = path.join(ROOT, 'data');

const SITEMAP_URL = 'https://www.nuffieldhealth.com/sitemap_gyms.xml';
const SITE_BASE = 'https://www.nuffieldhealth.com';

const CONCURRENCY = 8;

const NON_GYM_SLUGS = new Set([
  'membership',
  'services',
  'day-passes',
  'public-services',
  '247',
  'virtual-club-tour',
  'gyms-in-london',
  'gyms-in-glasgow',
  'club-in-club-social',
  'club-in-club-sporty',
  'nhanniversary',
  'health-mot-online-booking-coming-soon',
  'merton-abbey-gym-closure',
  'barrow',
  'canary-wharf-gym',
  'crawley-central-gym'
]);

const FACILITY_TERMS = [
  'swimming pool',
  'pool',
  'sauna',
  'steam room',
  'spa',
  'gym floor',
  'weights',
  'free weights',
  'cardio',
  'studio',
  'studios',
  'spin',
  'group exercise',
  'exercise classes',
  'personal training',
  'pt',
  'squash',
  'tennis',
  'badminton',
  'creche',
  'parking'
];

const JOIN_TEXT_TERMS = [
  'join',
  'join now',
  'join online',
  'become a member',
  'membership',
  'start your membership',
  'get started'
];

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'NuffieldGymAuditBot/1.0 (+internal assessment)'
    }
  });
  const text = await res.text();
  return { status: res.status, text, url: res.url };
}

function parseLocs(xmlText) {
  const locs = [];
  const regex = /<loc>(.*?)<\/loc>/g;
  let match;
  while ((match = regex.exec(xmlText)) !== null) {
    locs.push(decodeEntities(match[1]));
  }
  return locs;
}

function slugFromGymUrl(url) {
  const m = url.match(/^https:\/\/www\.nuffieldhealth\.com\/gyms\/([^/?#]+)\/?$/);
  return m ? m[1] : null;
}

function titleizeSlug(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function unique(arr) {
  return [...new Set(arr)];
}

function criterion(pass, evidence) {
  return {
    result: pass ? 'Pass' : 'Fail',
    pass,
    evidence
  };
}

function buildImageryEvidence(meaningfulImagesCount, modernFormatCount, lazyCount, pass) {
  if (pass) {
    return `Imagery looks strong: ${meaningfulImagesCount} relevant images detected, with modern delivery signals (${modernFormatCount} modern-format assets and ${lazyCount} lazy-loaded images).`;
  }

  const improvements = [];
  if (meaningfulImagesCount < 8) {
    improvements.push(`add more high-quality club imagery (currently ${meaningfulImagesCount}, target at least 8)`);
  }
  if (modernFormatCount < 1) {
    improvements.push('serve hero/gallery images in WebP or AVIF');
  }
  if (lazyCount < 3) {
    improvements.push(`enable lazy-loading on more non-critical images (currently ${lazyCount}, target at least 3)`);
  }

  return `Imagery needs improvement: ${meaningfulImagesCount} relevant images found, ${modernFormatCount} modern-format assets, ${lazyCount} lazy-loaded images. Recommended actions: ${improvements.join('; ')}.`;
}

function buildFacilitiesEvidence(facilitiesFound, hasFacilitiesSection, pass) {
  if (pass) {
    return `Facilities are clearly described. We found ${facilitiesFound.length} facility signals (${facilitiesFound.slice(0, 8).join(', ')}), and the page includes a clear facilities/amenities section.`;
  }

  const improvements = [];
  if (facilitiesFound.length < 10) {
    improvements.push(`list more specific facilities on the main page (currently ${facilitiesFound.length}, target at least 10)`);
  }
  if (!hasFacilitiesSection) {
    improvements.push('add a dedicated "Facilities" or "What is available" section above the fold');
  }

  const sample = facilitiesFound.length ? facilitiesFound.slice(0, 8).join(', ') : 'none detected';
  return `Facilities need improvement. We found ${facilitiesFound.length} facility signals (${sample}) and facilities section present = ${hasFacilitiesSection}. Recommended actions: ${improvements.join('; ')}.`;
}

function assessPage(url, html) {
  const $ = cheerio.load(html);

  const title = ($('title').first().text() || '').trim();
  const h1 = ($('h1').first().text() || '').trim();
  const metaDescription = ($('meta[name="description"]').attr('content') || '').trim();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const lower = bodyText.toLowerCase();

  const slug = slugFromGymUrl(url);
  const pagePath = slug ? `/gyms/${slug}` : '';

  const hasTimetableOrSubNav =
    $(`a[href*="${pagePath}/timetable"]`).length > 0 ||
    $(`a[href*="${pagePath}/classes"]`).length > 0 ||
    $(`a[href*="${pagePath}/services"]`).length > 0;

  const hasGymWords = /gym|health club|fitness/i.test(`${title} ${h1} ${metaDescription}`);
  const hasJoinWords = /join|membership/i.test(`${title} ${h1} ${metaDescription} ${bodyText.slice(0, 3000)}`);
  const isClosureOrPromo = /closure|coming soon|closed|promo|anniversary/i.test(`${title} ${h1} ${metaDescription}`);
  const isLikelyGymPage = ((hasTimetableOrSubNav && hasGymWords) || (hasGymWords && hasJoinWords)) && !isClosureOrPromo;

  const facilitiesFound = unique(
    FACILITY_TERMS.filter((term) => lower.includes(term))
  );
  const hasFacilitiesSection = /facilit(y|ies)|amenities|what's on offer|equipment/i.test(bodyText);
  const facilitiesPass = facilitiesFound.length >= 10 && hasFacilitiesSection;

  const imageRows = $('img')
    .toArray()
    .map((img) => {
      const el = $(img);
      return {
        src: (el.attr('src') || '').trim(),
        srcset: (el.attr('srcset') || '').trim(),
        alt: (el.attr('alt') || '').trim(),
        cls: (el.attr('class') || '').trim(),
        loading: (el.attr('loading') || '').trim()
      };
    });

  const meaningfulImages = imageRows.filter((img) => {
    const hay = `${img.src} ${img.srcset} ${img.alt} ${img.cls}`.toLowerCase();
    const ignore = /logo|icon|sprite|favicon|social|avatar/.test(hay);
    return !ignore && (img.src || img.srcset);
  });

  const modernFormatCount = meaningfulImages.filter((img) => {
    const hay = `${img.src} ${img.srcset}`.toLowerCase();
    return hay.includes('.webp') || hay.includes('.avif') || hay.includes('format=webp') || hay.includes('f_auto');
  }).length;

  const lazyCount = meaningfulImages.filter((img) => img.loading.toLowerCase() === 'lazy').length;
  const imageryPass = meaningfulImages.length >= 8 && (modernFormatCount >= 1 || lazyCount >= 3);

  const anchors = $('a').toArray().map((a, idx) => {
    const el = $(a);
    return {
      index: idx,
      text: (el.text() || '').replace(/\s+/g, ' ').trim(),
      href: (el.attr('href') || '').trim()
    };
  });

  const buttons = $('button').toArray().map((b, idx) => {
    const el = $(b);
    return {
      index: idx,
      text: (el.text() || '').replace(/\s+/g, ' ').trim(),
      href: ''
    };
  });

  const ctaCandidates = [];
  for (const c of [...anchors, ...buttons]) {
    const t = c.text.toLowerCase();
    const h = c.href.toLowerCase();
    const textMatch = JOIN_TEXT_TERMS.some((term) => t.includes(term));
    const hrefMatch = /join|membership|become-a-member|start/.test(h);
    if (textMatch || hrefMatch) ctaCandidates.push(c);
  }

  const hasOnlineSignal = ctaCandidates.some((c) => /join|membership|become-a-member|buy|checkout/.test(c.href.toLowerCase()));
  const hasTopCTA = ctaCandidates.some((c) => c.index < 30);
  const membershipOptionsLink = anchors.find((a) => /membership options/i.test(a.text));
  const joinRoutePresent = Boolean(membershipOptionsLink) || (ctaCandidates.length > 0 && hasOnlineSignal && hasTopCTA);

  let fixPriority = 'Low';
  const failCount = Number(!facilitiesPass) + Number(!imageryPass);
  if (!joinRoutePresent || failCount >= 2) {
    fixPriority = 'High';
  } else if (failCount === 1) {
    fixPriority = 'Medium';
  }

  return {
    url,
    slug,
    gymName: h1 || (slug ? titleizeSlug(slug) : title),
    title,
    isLikelyGymPage,
    criteria: {
      facilities: criterion(
        facilitiesPass,
        buildFacilitiesEvidence(facilitiesFound, hasFacilitiesSection, facilitiesPass)
      ),
      imagery: criterion(
        imageryPass,
        buildImageryEvidence(meaningfulImages.length, modernFormatCount, lazyCount, imageryPass)
      )
    },
    joinRoutePresent,
    joinRouteEvidence: joinRoutePresent
      ? 'Membership options/join route detected.'
      : 'No clear membership options/join route found on this page.',
    fixPriority
  };
}

async function runPool(items, worker, concurrency) {
  const results = [];
  let idx = 0;

  async function next() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: String(err), item: items[i] };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

function generateHtml(report) {
  const rows = report.gyms
    .map((g) => {
      const pf = (v) => `<span class="badge ${v.pass ? 'pass' : 'fail'}">${v.result}</span>`;
      return `<tr>
<td><a href="${g.url}" target="_blank" rel="noopener">${g.gymName}</a></td>
<td>${pf(g.criteria.facilities)}</td>
<td>${pf(g.criteria.imagery)}</td>
<td><span class="badge ${g.fixPriority === 'High' ? 'fail' : g.fixPriority === 'Medium' ? 'med' : 'pass'}">${g.fixPriority}</span></td>
<td>${g.joinRoutePresent ? 'Present' : 'Missing'}</td>
<td class="small">${g.criteria.facilities.evidence}</td>
<td class="small">${g.criteria.imagery.evidence}</td>
<td class="small">${g.joinRouteEvidence}</td>
</tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nuffield Health Gym Landing Page Audit</title>
<style>
:root {
  --nh-green-900: #0f5f2f;
  --nh-green-700: #1f8a43;
  --nh-green-500: #49b657;
  --nh-ink: #14311e;
  --nh-bg: #f3faf4;
  --pass: #0a8f52;
  --med: #b07600;
  --fail: #c4372c;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: "Poppins", "Segoe UI", Arial, sans-serif; color: var(--nh-ink); background: linear-gradient(180deg, #ffffff 0%, var(--nh-bg) 100%); }
header { background: linear-gradient(135deg, var(--nh-green-900), var(--nh-green-700)); color: #fff; padding: 24px 20px; }
.wrap { max-width: 1280px; margin: 0 auto; }
.brand { display: flex; align-items: center; gap: 14px; margin-bottom: 10px; }
.brand img { height: 38px; width: auto; display: block; }
h1 { margin: 0 0 8px; font-size: 1.8rem; }
.sub { margin: 0; opacity: 0.95; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin: 16px 0 8px; }
.card { background: #fff; border: 1px solid #d8e3ef; border-top: 4px solid var(--nh-green-700); border-radius: 10px; padding: 14px; }
.card b { font-size: 1.5rem; color: var(--nh-green-900); }
main { padding: 18px 20px 30px; }
.controls { margin-bottom: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
input { padding: 8px 10px; border: 1px solid #c1d2e4; border-radius: 8px; min-width: 260px; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d8e3ef; }
th, td { text-align: left; padding: 10px; border-bottom: 1px solid #e6eef7; vertical-align: top; }
th { background: #e9f7ea; position: sticky; top: 0; z-index: 1; }
.badge { display: inline-block; padding: 3px 8px; border-radius: 999px; color: #fff; font-size: 0.82rem; font-weight: 600; }
.badge.pass { background: var(--pass); }
.badge.med { background: var(--med); }
.badge.fail { background: var(--fail); }
.small { font-size: 0.84rem; color: #28425f; }
footer { padding: 14px 20px 24px; color: #38526f; font-size: 0.9rem; }
a { color: var(--nh-green-900); }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="brand">
      <img src="https://www.nuffieldhealth.com/assets/dist/images/logo_inverse.svg" alt="Nuffield Health logo" />
    </div>
    <h1>Nuffield Health Gym Landing Page Audit</h1>
    <p class="sub">Assessment across club pages for facilities clarity, imagery quality, and online join CTA clarity.</p>
    <div class="kpis">
      <div class="card"><div>Pages assessed</div><b>${report.summary.total}</b></div>
      <div class="card"><div>Facilities pass</div><b>${report.summary.facilitiesPass}</b></div>
      <div class="card"><div>Imagery pass</div><b>${report.summary.imageryPass}</b></div>
      <div class="card"><div>Join route missing</div><b>${report.summary.joinRouteMissing}</b></div>
    </div>
  </div>
</header>
<main class="wrap">
  <div class="controls">
    <input id="search" placeholder="Filter by gym name or URL" />
  </div>
  <table id="audit-table">
    <thead>
      <tr>
        <th>Gym Page</th>
        <th>Facilities</th>
        <th>Imagery</th>
        <th>Fix Priority</th>
        <th>Join Route</th>
        <th>Facilities Evidence</th>
        <th>Imagery Evidence</th>
        <th>Join Route Evidence</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</main>
<footer class="wrap">
  <div><b>Method:</b> Automated heuristic scoring of live page content from <a href="https://www.nuffieldhealth.com/sitemap_gyms.xml" target="_blank" rel="noopener">sitemap_gyms.xml</a>.</div>
  <div>Generated: ${report.generatedAt}</div>
</footer>
<script>
const search = document.getElementById('search');
const rows = Array.from(document.querySelectorAll('#audit-table tbody tr'));
search.addEventListener('input', () => {
  const q = search.value.toLowerCase().trim();
  for (const row of rows) {
    const t = row.textContent.toLowerCase();
    row.style.display = t.includes(q) ? '' : 'none';
  }
});
</script>
</body>
</html>`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const map = await fetchText(SITEMAP_URL);
  if (map.status >= 400) throw new Error(`Failed to fetch sitemap: ${map.status}`);

  const allLocs = parseLocs(map.text);
  const candidates = unique(
    allLocs.filter((u) => /^https:\/\/www\.nuffieldhealth\.com\/gyms\/[^/?#]+\/?$/.test(u))
  ).filter((u) => {
    const slug = slugFromGymUrl(u);
    return slug && !NON_GYM_SLUGS.has(slug);
  });

  console.log(`Candidates: ${candidates.length}`);

  const assessed = await runPool(
    candidates,
    async (url, i) => {
      const page = await fetchText(url);
      if (page.status >= 400) {
        return { url, status: page.status, skipped: true };
      }
      const row = assessPage(url, page.text);
      row.status = page.status;
      row.index = i + 1;
      return row;
    },
    CONCURRENCY
  );

  const gyms = assessed.filter((r) => r && !r.error && !r.skipped && r.isLikelyGymPage);
  gyms.sort((a, b) => a.gymName.localeCompare(b.gymName));

  const report = {
    generatedAt: new Date().toISOString(),
    source: SITEMAP_URL,
    candidateCount: candidates.length,
    includedCount: gyms.length,
    summary: {
      total: gyms.length,
      facilitiesPass: gyms.filter((g) => g.criteria.facilities.pass).length,
      imageryPass: gyms.filter((g) => g.criteria.imagery.pass).length,
      joinRouteMissing: gyms.filter((g) => !g.joinRoutePresent).length
    },
    gyms
  };

  fs.writeFileSync(path.join(DATA_DIR, 'audit-report.json'), JSON.stringify(report, null, 2));

  const csvHeader = [
    'gymName',
    'url',
    'fixPriority',
    'facilities',
    'imagery',
    'joinRoute',
    'facilitiesEvidence',
    'imageryEvidence',
    'joinRouteEvidence'
  ].join(',');
  const csvRows = gyms.map((g) => [
    `"${g.gymName.replaceAll('"', '""')}"`,
    `"${g.url}"`,
    g.fixPriority,
    g.criteria.facilities.result,
    g.criteria.imagery.result,
    g.joinRoutePresent ? 'Present' : 'Missing',
    `"${g.criteria.facilities.evidence.replaceAll('"', '""')}"`,
    `"${g.criteria.imagery.evidence.replaceAll('"', '""')}"`,
    `"${g.joinRouteEvidence.replaceAll('"', '""')}"`
  ].join(','));
  fs.writeFileSync(path.join(DATA_DIR, 'audit-report.csv'), [csvHeader, ...csvRows].join('\n'));

  const html = generateHtml(report);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);

  console.log(`Included gym pages: ${gyms.length}`);
  console.log(`Report written to: ${path.join(OUT_DIR, 'index.html')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
