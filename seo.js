// Structured data (schema.org JSON-LD) so jobs show up in Google for Jobs and
// the site gets rich results.

const EMPLOYMENT_TYPES = { 'Full-time': 'FULL_TIME', 'Part-time': 'PART_TIME', Contract: 'CONTRACTOR', Internship: 'INTERN' };
// Without a closing date, a posting is assumed valid for this long after it was
// posted. Once that has passed, validThrough is left out rather than telling
// Google a job that is still open has expired.
const VALID_DAYS = 60;

// "₹14 – 20 LPA" → { min: 1400000, max: 2000000 }. Anything else (e.g. "Competitive") → null.
function parseSalary(text) {
  const s = String(text || '');
  if (!/lpa|lakh/i.test(s)) return null;
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return null;
  const lakh = 100000;
  return { min: Math.round(nums[0] * lakh), max: Math.round((nums[1] ?? nums[0]) * lakh) };
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
      ? { baseSalary: { '@type': 'MonetaryAmount', currency: 'INR', value: { '@type': 'QuantitativeValue', minValue: salary.min, maxValue: salary.max, unitText: 'YEAR' } } }
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

module.exports = { jobPosting, article, homePage, toJsonLd, sitemap, parseSalary };
