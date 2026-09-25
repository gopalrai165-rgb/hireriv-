// Candidate ↔ job skill matching and the searchable talent pool.

// Lower-case, keep characters that matter in tech skills (c++, c#, node.js),
// and pad with spaces so "java" never matches inside "javascript".
const norm = (s) =>
  ` ${String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\.(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;

const candidateText = (c) => norm([c.skills, c.message].join(' '));

// Share of the job's required skills the candidate mentions, with the lists.
function skillMatch(candidate, job) {
  if (!job || !Array.isArray(job.skills) || !job.skills.length) return null;
  const text = candidateText(candidate);
  const matched = job.skills.filter((s) => text.includes(norm(s)));
  return {
    score: Math.round((matched.length / job.skills.length) * 100),
    matched,
    missing: job.skills.filter((s) => !matched.includes(s)),
  };
}

// One entry per candidate (by email), built from their newest application,
// remembering every job they applied for and every skill they listed.
function buildPool(applications) {
  const byEmail = new Map();
  for (const a of applications) {
    const key = String(a.email || '').toLowerCase();
    if (!key) continue;
    const entry = byEmail.get(key);
    if (!entry) {
      byEmail.set(key, { ...a, status: a.status || 'New', applicationCount: 1, jobsApplied: [a.jobTitle], skillsAll: [a.skills].filter(Boolean) });
      continue;
    }
    entry.applicationCount++;
    if (!entry.jobsApplied.includes(a.jobTitle)) entry.jobsApplied.push(a.jobTitle);
    if (a.skills) entry.skillsAll.push(a.skills);
    // Keep the freshest application as the candidate's current record.
    if (a.createdAt > entry.createdAt) Object.assign(entry, { ...a, status: a.status || 'New', applicationCount: entry.applicationCount, jobsApplied: entry.jobsApplied, skillsAll: entry.skillsAll });
  }
  return [...byEmail.values()]
    .map((c) => ({ ...c, skills: [...new Set(c.skillsAll.join(',').split(',').map((s) => s.trim()).filter(Boolean))].join(', ') }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function searchPool(pool, { q = '', experience = '', notice = '', status = '', job = null }) {
  const terms = norm(q).trim().split(' ').filter(Boolean);
  let list = pool.filter((c) => {
    if (experience && c.experience !== experience) return false;
    if (notice && c.noticePeriod !== notice) return false;
    if (status && c.status !== status) return false;
    if (!terms.length) return true;
    const hay = norm([c.name, c.email, c.skills, c.location, c.experience, c.jobsApplied.join(' '), c.notes, c.message].join(' '));
    return terms.every((t) => hay.includes(t));
  });
  if (job) {
    list = list
      .map((c) => ({ ...c, match: skillMatch(c, job) }))
      .sort((a, b) => (b.match?.score || 0) - (a.match?.score || 0) || b.createdAt.localeCompare(a.createdAt));
  }
  return list;
}

module.exports = { skillMatch, buildPool, searchPool };
