// Structured data (schema.org JSON-LD) so jobs show up in Google for Jobs and
// the site gets rich results.

const EMPLOYMENT_TYPES = { 'Full-time': 'FULL_TIME', 'Part-time': 'PART_TIME', Contract: 'CONTRACTOR', Temporary: 'TEMPORARY', 'Daily wage / Gig': 'PER_DIEM', Apprenticeship: 'OTHER', Internship: 'INTERN' };
// Without a closing date, a posting is assumed valid for this long after it was
// posted. Once that has passed, validThrough is left out rather than telling
// Google a job that is still open has expired.
const VALID_DAYS = 60;

// Salary text → a range Google for Jobs understands, or null (e.g. "Competitive").
// "₹14 – 20 LPA" is per year; blue-collar pay is usually per month, day or hour:
// "₹16,000 – 20,000 per month", "₹800/day".
function parseSalary(text) {
  const s = String(text || '');
  const nums = (s.replace(/(\d),(?=\d)/g, '$1').match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return null;
  const range = (scale, unit) => ({ min: Math.round(nums[0] * scale), max: Math.round((nums[1] ?? nums[0]) * scale), unit });
  if (/lpa|lakh/i.test(s)) return range(100000, 'YEAR');
  if (/per\s*month|\/\s*month|monthly/i.test(s)) return range(1, 'MONTH');
  if (/per\s*day|\/\s*day|daily/i.test(s)) return range(1, 'DAY');
  if (/per\s*hour|\/\s*h(?:ou)?r|hourly/i.test(s)) return range(1, 'HOUR');
  return null;
}

function organization(site, baseUrl) {
  const sameAs = Object.values(site.social || {}).filter((u) => /^https?:\/\//.test(u));
  return {
    '@type': 'Organization',
    name: site.name,
    url: baseUrl,
    logo: `${baseUrl}/img/logo.svg`,
    ...(sameAs.length ? { sameAs } : {}),
  };
}

function jobPosting(job, site, baseUrl) {
  const assumed = new Date(new Date(job.posted).getTime() + VALID_DAYS * 86400000).toISOString().slice(0, 10);
  const validThrough = job.closesOn ? `${job.closesOn}T23:59:59+05:30` : (assumed >= new Date().toISOString().slice(0, 10) ? assumed : null);
  const remote = job.mode === 'Remote';
  const salary = parseSalary(job.salary);
  const description = [
    `<p>${escapeHtml(job.description)}</p>`,
    job.responsibilities.length ? `<p><strong>Responsibilities</strong></p><ul>${job.responsibilities.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '',
    job.skills.length ? `<p><strong>Key skills:</strong> ${escapeHtml(job.skills.join(', '))}</p>` : '',
    job.experience ? `<p><strong>Experience:</strong> ${escapeHtml(job.experience)}</p>` : '',
  ].join('');

  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description,
    identifier: { '@type': 'PropertyValue', name: site.name, value: job.id },
    datePosted: job.posted,
    ...(validThrough ? { validThrough } : {}),
    employmentType: EMPLOYMENT_TYPES[job.type] || 'OTHER',
    // Client names are confidential, so Hireriv is the hiring organisation of record.
    hiringOrganization: organization(site, baseUrl),
    ...(remote
      ? { jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { '@type': 'Country', name: 'India' } }
      : { jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: job.location, addressCountry: 'IN' } } }),
    ...(salary
      ? { baseSalary: { '@type': 'MonetaryAmount', currency: 'INR', value: { '@type': 'QuantitativeValue', minValue: salary.min, maxValue: salary.max, unitText: salary.unit } } }
      : {}),
    skills: job.skills.join(', '),
    industry: job.category,
    directApply: true,
    url: `${baseUrl}/jobs/${job.id}`,
  };
}

function article(post, site, baseUrl) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.excerpt,
    datePublished: post.date,
    author: { '@type': 'Organization', name: `${site.name} Team` },
    publisher: organization(site, baseUrl),
    mainEntityOfPage: `${baseUrl}/blog/${post.slug}`,
  };
}

function homePage(site, baseUrl) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { ...organization(site, baseUrl), '@type': ['Organization', 'EmploymentAgency'], email: site.email, telephone: site.phone },
      {
        '@type': 'WebSite',
        name: site.name,
        url: baseUrl,
        potentialAction: { '@type': 'SearchAction', target: `${baseUrl}/jobs?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
      },
    ],
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Safe to drop inside <script type="application/ld+json">: no "</script>" breakout.
const toJsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

function sitemap(baseUrl, { jobs, posts, staticPaths }) {
  const today = new Date().toISOString().slice(0, 10);
  const url = (loc, lastmod) => `  <url><loc>${escapeHtml(baseUrl + loc)}</loc><lastmod>${lastmod}</lastmod></url>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...staticPaths.map((p) => url(p, today)),
    ...jobs.map((j) => url(`/jobs/${j.id}`, j.posted)),
    ...posts.map((p) => url(`/blog/${p.slug}`, p.date)),
    '</urlset>',
  ].join('\n');
}

function breadcrumbs(baseUrl, trail) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: baseUrl + path })),
  };
}

// A service page: the service itself, its FAQ (eligible for FAQ rich results) and breadcrumbs.
function servicePage(service, site, baseUrl) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Service', name: service.name, serviceType: service.name, description: service.intro, provider: organization(site, baseUrl), areaServed: { '@type': 'Country', name: 'India' }, url: `${baseUrl}/services/${service.slug}` },
      { '@type': 'FAQPage', mainEntity: service.faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
      breadcrumbs(baseUrl, [['Home', '/'], ['Services', '/services'], [service.name, `/services/${service.slug}`]]),
    ],
  };
}

function industryPage(industry, baseUrl) {
  return { '@context': 'https://schema.org', ...breadcrumbs(baseUrl, [['Home', '/'], ['Industries', '/industries'], [industry.name, `/industries/${industry.slug}`]]) };
}

module.exports = { jobPosting, article, homePage, toJsonLd, sitemap, parseSalary, servicePage, industryPage };
