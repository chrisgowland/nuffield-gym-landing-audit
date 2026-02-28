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

const CORE_FACILITIES = [
  { key: 'gym', label: 'Gym', test: (t) => /\bgym\b|gym floor|fitness suite/.test(t) },
  { key: 'sauna', label: 'Sauna', test: (t) => /\bsauna\b/.test(t) },
  { key: 'steam', label: 'Steam', test: (t) => /\bsteam\b|steam room/.test(t) },
  { key: 'pool', label: 'Pool', test: (t) => /\bpool\b|swimming pool/.test(t) },
  { key: 'pt', label: 'PT', test: (t) => /\bpersonal training\b|\bpt\b/.test(t) },
  { key: 'classes', label: 'Classes', test: (t) => /\bclasses?\b|group exercise|studio classes/.test(t) }
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
  const lazyStatus = lazyCount >= 3 ? 'Good' : 'Needs work';
  const modernStatus = modernFormatCount >= 1 ? 'Good' : 'Needs work';

  if (pass) {
    return `Imagery looks strong. Relevant images: ${meaningfulImagesCount} (target 8+). Lazy-load: ${lazyStatus} (${lazyCount} of 3 target). Modern format: ${modernStatus} (${modernFormatCount} of 1 target).`;
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

  return `Imagery needs improvement. Relevant images: ${meaningfulImagesCount} (target 8+). Lazy-load: ${lazyStatus} (${lazyCount} of 3 target). Modern format: ${modernStatus} (${modernFormatCount} of 1 target). Recommended actions: ${improvements.join('; ')}.`;
}

function buildCoreFacilitiesEvidence(foundLabels, pass) {
  const required = CORE_FACILITIES.map((f) => f.label);
  if (pass) {
    return `Core facilities are clearly listed: ${required.join(', ')}.`;
  }

  const missing = required.filter((name) => !foundLabels.includes(name));
  return `Core facilities are incomplete. Missing from the page copy: ${missing.join(', ')}. Recommended action: add these items explicitly in a dedicated facilities section near the top of the page.`;
}

function assessClubDescription(h1, metaDescription, bodyText) {
  const snippet = `${h1}. ${metaDescription}`.trim();
  const lowerSnippet = snippet.toLowerCase();
  const lowerBody = bodyText.toLowerCase();

  const appealTerms = [
    'modern',
    'state-of-the-art',
    'expert',
    'friendly',
    'support',
    'wellbeing',
    'community',
    'spacious',
    'premium',
    'motivating',
    'award',
    'refurbished'
  ];

  const benefitTerms = [
    'help you',
    'whether you',
    'whatever your goal',
    'tailored',
    'personalised',
    'achieve',
    'improve',
    'feel better'
  ];

  const appealHits = appealTerms.filter((t) => lowerSnippet.includes(t) || lowerBody.includes(t)).length;
  const benefitHits = benefitTerms.filter((t) => lowerSnippet.includes(t) || lowerBody.includes(t)).length;
  const hasStrongDescription = snippet.length >= 120 && appealHits >= 2 && benefitHits >= 1;

  if (hasStrongDescription) {
    return {
      tone: 'Appealing',
      text: 'The club description is appealing. It communicates clear benefits and uses persuasive language about the experience.'
    };
  }

  return {
    tone: 'Needs improvement',
    text: 'The club description is not very compelling yet. Improve it by adding clearer member benefits, more distinctive language about the experience, and one strong value proposition in the opening paragraph.'
  };
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

  const coreFound = CORE_FACILITIES.filter((f) => f.test(lower)).map((f) => f.label);
  const coreFacilitiesPass = coreFound.length === CORE_FACILITIES.length;
  const descriptionAssessment = assessClubDescription(h1, metaDescription, bodyText);

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
  const failCount = Number(!coreFacilitiesPass) + Number(!imageryPass);
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
      coreFacilities: criterion(
        coreFacilitiesPass,
        buildCoreFacilitiesEvidence(coreFound, coreFacilitiesPass)
      ),
      imagery: criterion(
        imageryPass,
        buildImageryEvidence(meaningfulImages.length, modernFormatCount, lazyCount, imageryPass)
      )
    },
    clubDescription: descriptionAssessment,
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
  const total = report.summary.total || 0;
  const corePass = report.summary.coreFacilitiesPass || 0;
  const coreFail = total - corePass;
  const imageryPass = report.summary.imageryPass || 0;
  const imageryFail = total - imageryPass;
  const joinMissing = report.summary.joinRouteMissing || 0;
  const highPriority = report.gyms.filter((g) => g.fixPriority === 'High').length;

  const rows = report.gyms
    .map((g) => {
      const pf = (v) => `<span class="badge ${v.pass ? 'pass' : 'fail'}">${v.result}</span>`;
      return `<tr>
<td><a href="${g.url}" target="_blank" rel="noopener">${g.gymName}</a></td>
<td>${pf(g.criteria.coreFacilities)}</td>
<td>${pf(g.criteria.imagery)}</td>
<td><span class="badge ${g.fixPriority === 'High' ? 'fail' : g.fixPriority === 'Medium' ? 'med' : 'pass'}">${g.fixPriority}</span></td>
<td>${g.joinRoutePresent ? 'Present' : 'Missing'}</td>
<td class="small">${g.criteria.coreFacilities.evidence}</td>
<td class="small">${g.criteria.imagery.evidence}</td>
<td><div class="assessment-box"><b>${g.clubDescription.tone}</b><br>${g.clubDescription.text}</div></td>
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
.card .label { font-size: 0.88rem; color: #2c4c37; font-weight: 600; margin-bottom: 4px; }
.card .detail { font-size: 0.82rem; color: #486351; margin-top: 4px; }
main { padding: 18px 20px 30px; }
.controls { margin-bottom: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
input { padding: 8px 10px; border: 1px solid #c1d2e4; border-radius: 8px; min-width: 260px; }
select { padding: 8px 10px; border: 1px solid #c1d2e4; border-radius: 8px; min-width: 160px; background: #fff; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d8e3ef; }
th, td { text-align: left; padding: 10px; border-bottom: 1px solid #e6eef7; vertical-align: top; }
th { background: #e9f7ea; position: sticky; top: 0; z-index: 1; }
.filter-row th { position: static; background: #f6fbf7; }
.filter-row input, .filter-row select { width: 100%; min-width: 0; font-size: 0.8rem; padding: 6px 8px; }
.badge { display: inline-block; padding: 3px 8px; border-radius: 999px; color: #fff; font-size: 0.82rem; font-weight: 600; }
.badge.pass { background: var(--pass); }
.badge.med { background: var(--med); }
.badge.fail { background: var(--fail); }
.small { font-size: 0.84rem; color: #28425f; }
.assessment-box { background: #f2fbf4; border: 1px solid #cfead4; border-radius: 8px; padding: 8px; font-size: 0.84rem; color: #234132; min-width: 260px; }
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
      <div class="card"><div class="label">Gym Pages Reviewed</div><b>${total}</b><div class="detail">Total gym landing pages in scope</div></div>
      <div class="card"><div class="label">Core Facilities</div><b>${corePass} Pass</b><div class="detail">${coreFail} Fail</div></div>
      <div class="card"><div class="label">Imagery Quality</div><b>${imageryPass} Pass</b><div class="detail">${imageryFail} Fail</div></div>
      <div class="card"><div class="label">Join Route Coverage</div><b>${total - joinMissing} Present</b><div class="detail">${joinMissing} Missing</div></div>
      <div class="card"><div class="label">High Priority Fixes</div><b>${highPriority}</b><div class="detail">Pages needing urgent action</div></div>
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
        <th>Core Facilities</th>
        <th>Imagery</th>
        <th>Fix Priority</th>
        <th>Join Route</th>
        <th>Core Facilities Evidence</th>
        <th>Imagery Evidence</th>
        <th>Club Description Assessment</th>
        <th>Join Route Evidence</th>
      </tr>
      <tr class="filter-row">
        <th><input data-filter-col="0" placeholder="Filter gym" /></th>
        <th>
          <select data-filter-col="1">
            <option value="">All</option>
            <option>Pass</option>
            <option>Fail</option>
          </select>
        </th>
        <th>
          <select data-filter-col="2">
            <option value="">All</option>
            <option>Pass</option>
            <option>Fail</option>
          </select>
        </th>
        <th>
          <select data-filter-col="3">
            <option value="">All</option>
            <option>High</option>
            <option>Medium</option>
            <option>Low</option>
          </select>
        </th>
        <th>
          <select data-filter-col="4">
            <option value="">All</option>
            <option>Present</option>
            <option>Missing</option>
          </select>
        </th>
        <th><input data-filter-col="5" placeholder="Filter core facilities evidence" /></th>
        <th><input data-filter-col="6" placeholder="Filter imagery evidence" /></th>
        <th><input data-filter-col="7" placeholder="Filter description assessment" /></th>
        <th><input data-filter-col="8" placeholder="Filter join route evidence" /></th>
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
const columnFilters = Array.from(document.querySelectorAll('[data-filter-col]'));

function applyFilters() {
  const q = search.value.toLowerCase().trim();
  const activeColumnFilters = columnFilters.map((el) => ({
    col: Number(el.getAttribute('data-filter-col')),
    value: (el.value || '').toLowerCase().trim()
  }));

  for (const row of rows) {
    const allText = row.textContent.toLowerCase();
    if (q && !allText.includes(q)) {
      row.style.display = 'none';
      continue;
    }

    const cells = Array.from(row.querySelectorAll('td'));
    let matched = true;
    for (const filter of activeColumnFilters) {
      if (!filter.value) continue;
      const cell = cells[filter.col];
      const text = (cell ? cell.textContent : '').toLowerCase();
      if (!text.includes(filter.value)) {
        matched = false;
        break;
      }
    }

    row.style.display = matched ? '' : 'none';
  }
}

search.addEventListener('input', applyFilters);
for (const el of columnFilters) {
  el.addEventListener('input', applyFilters);
  el.addEventListener('change', applyFilters);
}
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
      coreFacilitiesPass: gyms.filter((g) => g.criteria.coreFacilities.pass).length,
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
    'coreFacilities',
    'imagery',
    'joinRoute',
    'coreFacilitiesEvidence',
    'imageryEvidence',
    'clubDescriptionTone',
    'clubDescriptionAssessment',
    'joinRouteEvidence'
  ].join(',');
  const csvRows = gyms.map((g) => [
    `"${g.gymName.replaceAll('"', '""')}"`,
    `"${g.url}"`,
    g.fixPriority,
    g.criteria.coreFacilities.result,
    g.criteria.imagery.result,
    g.joinRoutePresent ? 'Present' : 'Missing',
    `"${g.criteria.coreFacilities.evidence.replaceAll('"', '""')}"`,
    `"${g.criteria.imagery.evidence.replaceAll('"', '""')}"`,
    `"${g.clubDescription.tone.replaceAll('"', '""')}"`,
    `"${g.clubDescription.text.replaceAll('"', '""')}"`,
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
