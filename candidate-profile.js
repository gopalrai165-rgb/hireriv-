// A candidate's profile: what each section holds, how changes are checked
// (from the profile page and from PATCH /api/candidate/profile alike), and how
// complete it is. Only details that help match people to jobs are asked for:
// never Aadhaar, PAN, bank details, date of birth or other identity documents.
const crypto = require('crypto');

const EXPERIENCE = ['Fresher', '0-1 years', '1-3 years', '3-5 years', '5-10 years', '10+ years'];
const NOTICE = ['Immediate', '15 days', '30 days', '60 days', '90 days'];
const EDUCATION_LEVELS = ['Below 10th', '10th pass', '12th pass', 'ITI', 'Diploma', 'Graduate', 'Post-graduate', 'Doctorate'];
const LANGUAGE_LEVELS = ['Basic', 'Conversational', 'Fluent', 'Native'];
const SHIFTS = ['Day', 'Night', 'Rotational', 'Flexible'];
const SALARY_PERIODS = ['month', 'year'];
const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan',
  'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];
const PHONE_RE = /^[+\d][\d\s-]{7,16}$/;
const URL_RE = /^https?:\/\/[^\s"'<>]+$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIMITS = { categories: 5, locations: 5, skills: 30, certifications: 20, languages: 10, experiences: 20, education: 10 };

function emptyProfile() {
  return {
    name: '', phone: '', city: '', state: '', headline: '', linkedin: '', experienceLevel: '',
    preferences: { roles: '', categories: [], locations: [], types: [], arrangements: [], shifts: [], relocate: false },
    salary: { expected: null, period: 'month' },
    availability: { noticePeriod: '', availableFrom: '' },
    skills: [], certifications: [], languages: [], experiences: [], education: [],
  };
}
// Recruiters on the Hireriv team may find a profile unless the person says no;
// employers only when the person says yes.
const defaultPrivacy = () => ({ visibleToRecruiters: true, discoverable: false, shareContact: false });
const defaultComms = () => ({ whatsapp: false, sms: false, offers: false });

const newId = () => crypto.randomBytes(6).toString('hex');
const str = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const bool = (v) => v === true || v === 'true' || v === '1' || v === 'on' || v === 1;
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const thisYear = () => new Date().getFullYear();
// The first of each, ignoring case ("Tally, tally" → "Tally").
const uniqueBy = (list, key) => {
  const seen = new Set();
  return list.filter((x) => { const k = key(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
};

// Checks a change to the profile. `input` has only the parts being changed;
// arrays replace the whole list. ctx: { categories, cities, types, modes }.
// Returns { patch, errors }; unknown fields are refused so nothing unexpected
// (identity numbers, bank details…) can be stored.
function parsePatch(input, ctx) {
  const errors = [];
  const patch = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { patch, errors: ['send the profile changes as an object'] };
  const known = ['name', 'phone', 'city', 'state', 'headline', 'linkedin', 'experienceLevel', 'preferences', 'salary', 'availability', 'skills', 'certifications', 'languages', 'experiences', 'education'];
  for (const k of Object.keys(input)) if (!known.includes(k)) errors.push(`${k} is not a profile field`);
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const pickList = (label, v, allowed, max) => {
    const list = [...new Set(arr(v).map((x) => String(x)))];
    const bad = list.filter((x) => !allowed.includes(x));
    if (bad.length) errors.push(`${label}: choose from the list`);
    if (list.length > max) errors.push(`${label}: choose up to ${max}`);
    return list.filter((x) => allowed.includes(x)).slice(0, max);
  };

  if (has('name')) {
    patch.name = str(input.name, 120);
    if (!patch.name) errors.push('Please enter your name.');
  }
  if (has('phone')) {
    patch.phone = str(input.phone, 20);
    if (!PHONE_RE.test(patch.phone)) errors.push('Please enter a valid mobile number.');
  }
  if (has('city')) patch.city = str(input.city, 80);
  if (has('state')) {
    patch.state = str(input.state, 80);
    if (patch.state && !INDIAN_STATES.includes(patch.state)) errors.push('State: choose from the list');
  }
  if (has('headline')) patch.headline = str(input.headline, 120);
  if (has('linkedin')) {
    patch.linkedin = str(input.linkedin, 300);
    if (patch.linkedin && !URL_RE.test(patch.linkedin)) errors.push('LinkedIn / portfolio must be a full link starting with https://');
  }
  if (has('experienceLevel')) {
    patch.experienceLevel = str(input.experienceLevel, 20);
    if (patch.experienceLevel && !EXPERIENCE.includes(patch.experienceLevel)) errors.push('Experience: choose from the list');
  }

  if (has('preferences')) {
    const p = input.preferences || {};
    patch.preferences = {
      roles: str(p.roles, 200),
      categories: pickList('Job categories', p.categories, ctx.categories, LIMITS.categories),
      locations: pickList('Preferred locations', p.locations, ctx.cities, LIMITS.locations),
      types: pickList('Employment types', p.types, ctx.types, ctx.types.length),
      arrangements: pickList('Work arrangements', p.arrangements, ctx.modes, ctx.modes.length),
      shifts: pickList('Shifts', p.shifts, SHIFTS, SHIFTS.length),
      relocate: bool(p.relocate),
    };
  }
  if (has('salary')) {
    const s = input.salary || {};
    const raw = String(s.expected ?? '').replace(/[,₹\s]/g, '');
    const expected = raw === '' ? null : Number(raw);
    if (expected !== null && !(Number.isFinite(expected) && expected > 0 && expected <= 1e9)) errors.push('Expected pay must be a positive number.');
    const period = SALARY_PERIODS.includes(s.period) ? s.period : 'month';
    patch.salary = { expected: expected !== null && Number.isFinite(expected) && expected > 0 && expected <= 1e9 ? Math.round(expected) : null, period };
  }
  if (has('availability')) {
    const a = input.availability || {};
    const noticePeriod = str(a.noticePeriod, 20);
    if (noticePeriod && !NOTICE.includes(noticePeriod)) errors.push('Notice period: choose from the list');
    const availableFrom = str(a.availableFrom, 10);
    if (availableFrom && !(DATE_RE.test(availableFrom) && !Number.isNaN(Date.parse(availableFrom)))) errors.push('Available from must be a date.');
    patch.availability = { noticePeriod: NOTICE.includes(noticePeriod) ? noticePeriod : '', availableFrom: DATE_RE.test(availableFrom) ? availableFrom : '' };
  }
  if (has('skills')) {
    const list = (Array.isArray(input.skills) ? input.skills : String(input.skills || '').split(','))
      .map((s) => str(s, 40)).filter(Boolean);
    const unique = uniqueBy(list, (s) => s);
    if (unique.length > LIMITS.skills) errors.push(`Skills: up to ${LIMITS.skills}`);
    patch.skills = unique.slice(0, LIMITS.skills);
  }
  if (has('certifications')) {
    const list = arr(input.certifications).map((c) => (typeof c === 'string' ? { name: c } : c || {}))
      .map((c) => ({ name: str(c.name, 120), issuer: str(c.issuer, 120), year: str(c.year, 4) })).filter((c) => c.name);
    for (const c of list) if (c.year && !(/^\d{4}$/.test(c.year) && +c.year >= 1950 && +c.year <= thisYear() + 1)) errors.push(`Certification year for ${c.name} must be a year.`);
    if (list.length > LIMITS.certifications) errors.push(`Certifications: up to ${LIMITS.certifications}`);
    patch.certifications = list.slice(0, LIMITS.certifications);
  }
  if (has('languages')) {
    const list = arr(input.languages).map((l) => (typeof l === 'string' ? { name: l, level: 'Conversational' } : l || {}))
      .map((l) => ({ name: str(l.name, 40), level: str(l.level, 20) })).filter((l) => l.name);
    for (const l of list) if (!LANGUAGE_LEVELS.includes(l.level)) errors.push(`Language level for ${l.name}: choose from the list`);
    if (list.length > LIMITS.languages) errors.push(`Languages: up to ${LIMITS.languages}`);
    patch.languages = uniqueBy(list, (l) => l.name).slice(0, LIMITS.languages);
  }
  if (has('experiences')) {
    const list = arr(input.experiences).map((e) => e || {}).map((e) => ({
      id: /^[a-f0-9]{12}$/.test(String(e.id)) ? String(e.id) : newId(),
      title: str(e.title, 120), company: str(e.company, 120), from: str(e.from, 7), to: bool(e.current) ? '' : str(e.to, 7),
      current: bool(e.current), summary: String(e.summary ?? '').trim().slice(0, 1000),
    }));
    for (const e of list) {
      if (!e.title) errors.push('Each job in your experience needs a job title.');
      if (e.from && !MONTH_RE.test(e.from)) errors.push(`Start month for ${e.title || 'a job'} must look like 2024-06.`);
      if (e.to && !MONTH_RE.test(e.to)) errors.push(`End month for ${e.title || 'a job'} must look like 2024-06.`);
      if (MONTH_RE.test(e.from) && MONTH_RE.test(e.to) && e.from > e.to) errors.push(`${e.title || 'A job'} ends before it starts.`);
    }
    if (list.length > LIMITS.experiences) errors.push(`Experience: up to ${LIMITS.experiences} jobs`);
    patch.experiences = list.slice(0, LIMITS.experiences);
  }
  if (has('education')) {
    const list = arr(input.education).map((e) => e || {}).map((e) => ({
      id: /^[a-f0-9]{12}$/.test(String(e.id)) ? String(e.id) : newId(),
      level: str(e.level, 30), course: str(e.course, 120), institution: str(e.institution, 160), year: str(e.year, 4),
    }));
    for (const e of list) {
      if (!EDUCATION_LEVELS.includes(e.level)) errors.push('Education level: choose from the list');
      if (e.year && !(/^\d{4}$/.test(e.year) && +e.year >= 1950 && +e.year <= thisYear() + 6)) errors.push('Education year must be a year.');
    }
    if (list.length > LIMITS.education) errors.push(`Education: up to ${LIMITS.education}`);
    patch.education = list.slice(0, LIMITS.education);
  }
  return { patch, errors: [...new Set(errors)] };
}

const applyPatch = (profile, patch) => ({ ...emptyProfile(), ...profile, ...patch });

// How complete the profile is, and what to add next (with where to add it).
const SECTIONS = [
  { key: 'basics', label: 'Your name, mobile and city', weight: 15, done: (p) => Boolean(p.name && p.phone && p.city), href: '/account/profile#basics' },
  { key: 'skills', label: 'At least 3 key skills', weight: 15, done: (p) => p.skills.length >= 3, href: '/account/profile#skills' },
  { key: 'experience', label: 'Your work experience (or that you are a fresher)', weight: 15, done: (p) => p.experiences.length > 0 || p.experienceLevel === 'Fresher', href: '/account/profile#experience' },
  { key: 'resume', label: 'A resume', weight: 15, done: (p, x) => x.hasResume, href: '/account/profile#resume' },
  { key: 'preferences', label: 'The jobs and places you want', weight: 15, done: (p) => Boolean((p.preferences.roles || p.preferences.categories.length) && p.preferences.locations.length), href: '/account/profile#preferences' },
  { key: 'education', label: 'Your education', weight: 10, done: (p) => p.education.length > 0, href: '/account/profile#education' },
  { key: 'salary', label: 'Expected pay', weight: 5, done: (p) => Boolean(p.salary.expected), href: '/account/profile#preferences' },
  { key: 'availability', label: 'When you can start', weight: 5, done: (p) => Boolean(p.availability.noticePeriod || p.availability.availableFrom), href: '/account/profile#preferences' },
  { key: 'languages', label: 'Languages you speak', weight: 5, done: (p) => p.languages.length > 0, href: '/account/profile#skills' },
];
function completion(profile, { hasResume = false } = {}) {
  const p = applyPatch(profile, {});
  let percent = 0;
  const missing = [];
  for (const s of SECTIONS) {
    if (s.done(p, { hasResume })) percent += s.weight;
    else missing.push({ key: s.key, label: s.label, href: s.href });
  }
  return { percent, missing };
}

// The flat details every application carries, so recruiters, skill matching
// and the talent pool see the latest profile.
function applicationFields(p) {
  const years = p.experienceLevel || '';
  return {
    name: p.name || '', phone: p.phone || '', skills: (p.skills || []).join(', '), experience: years,
    location: [p.city, p.state].filter(Boolean).join(', '), noticePeriod: (p.availability && p.availability.noticePeriod) || '', linkedin: p.linkedin || '',
  };
}

module.exports = {
  EXPERIENCE, NOTICE, EDUCATION_LEVELS, INDIAN_STATES, LANGUAGE_LEVELS, SHIFTS, SALARY_PERIODS, LIMITS, PHONE_RE,
  emptyProfile, defaultPrivacy, defaultComms, parsePatch, applyPatch, completion, applicationFields, SECTIONS,
};
