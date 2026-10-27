// "Jobs near me": where a job's city is, where the job seeker is, and how far
// apart they are. Cities are the job locations Hireriv uses (city centres,
// so distances are approximate). A PIN code is placed by its first digits
// (the postal district), which is enough to sort by distance; a PIN code
// outside these districts is not placed rather than guessed. The job seeker's
// position is never stored: the browser rounds it to about a kilometre and it
// only lives in the address of the search page.
const CITIES = {
  Bengaluru: [12.97, 77.59], Mumbai: [19.08, 72.88], 'Navi Mumbai': [19.03, 73.03], Thane: [19.22, 72.98],
  Delhi: [28.61, 77.21], 'Delhi NCR': [28.61, 77.21], Gurugram: [28.46, 77.03], Noida: [28.54, 77.39],
  Hyderabad: [17.39, 78.49], Chennai: [13.08, 80.27], Pune: [18.52, 73.86], Kolkata: [22.57, 88.36],
  Ahmedabad: [23.02, 72.57], Jaipur: [26.91, 75.79], Chandigarh: [30.73, 76.78], Kochi: [9.93, 76.27],
  Coimbatore: [11.02, 76.96], Indore: [22.72, 75.86], Lucknow: [26.85, 80.95], Bhubaneswar: [20.30, 85.82],
  Nagpur: [21.15, 79.09], Visakhapatnam: [17.69, 83.22], Vadodara: [22.31, 73.18], Surat: [21.17, 72.83],
  Mysuru: [12.30, 76.64], Thiruvananthapuram: [8.52, 76.94], Guwahati: [26.14, 91.74], Bhopal: [23.26, 77.41],
  Patna: [25.59, 85.14], Goa: [15.49, 73.83],
};

// PIN code prefixes, longest first wins.
const PIN_PREFIXES = {
  4007: 'Navi Mumbai', 4006: 'Thane', 400: 'Mumbai', 110: 'Delhi', 122: 'Gurugram', 201: 'Noida', 560: 'Bengaluru',
  500: 'Hyderabad', 600: 'Chennai', 411: 'Pune', 700: 'Kolkata', 380: 'Ahmedabad', 302: 'Jaipur', 160: 'Chandigarh',
  682: 'Kochi', 641: 'Coimbatore', 452: 'Indore', 226: 'Lucknow', 751: 'Bhubaneswar', 440: 'Nagpur', 530: 'Visakhapatnam',
  390: 'Vadodara', 395: 'Surat', 570: 'Mysuru', 695: 'Thiruvananthapuram', 781: 'Guwahati', 462: 'Bhopal', 800: 'Patna', 403: 'Goa',
};
const RADII = [5, 10, 25, 50, 100];

const coordsOf = (city) => CITIES[city] || null;

function cityOfPin(pin) {
  if (!/^[1-9]\d{5}$/.test(String(pin))) return null;
  for (const len of [4, 3]) {
    const city = PIN_PREFIXES[String(pin).slice(0, len)];
    if (city) return city;
  }
  return null;
}

// Great-circle distance in kilometres.
function distanceKm([lat1, lng1], [lat2, lng2]) {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// The `near` search parameter: "lat,lng" from the browser (inside India,
// rounded to 2 decimals), a 6-digit PIN code, or a city name. Returns
// { point, label, kind, value } or { error } (a locale key under "near",
// with `pin` for the PIN code); '' gives null.
function parseNear(value) {
  const v = String(value || '').trim().slice(0, 60);
  if (!v) return null;
  const m = /^(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(v);
  if (m) {
    const lat = Math.round(Number(m[1]) * 100) / 100;
    const lng = Math.round(Number(m[2]) * 100) / 100;
    if (lat < 6 || lat > 37.5 || lng < 68 || lng > 97.5) return { error: 'errOutside' };
    return { point: [lat, lng], label: 'your location', kind: 'gps', value: `${lat},${lng}` };
  }
  if (/^\d{6}$/.test(v)) {
    const city = cityOfPin(v);
    return city ? { point: CITIES[city], label: `${v} (${city})`, kind: 'pin', value: v } : { error: 'errPin', pin: v };
  }
  const city = Object.keys(CITIES).find((c) => c.toLowerCase() === v.toLowerCase());
  return city ? { point: CITIES[city], label: city, kind: 'city', value: city } : { error: 'errFormat' };
}

// How far the job is from `point`, or null for remote, several places, or an unknown city.
function jobDistance(job, point) {
  const c = coordsOf(job.location);
  return c && point ? distanceKm(point, c) : null;
}

// Kilometres as shown: exact under 20, else to the nearest 5 (city centres
// are approximate); under 3 km counts as the same city (null).
const shownKm = (km) => (km < 3 ? null : km < 20 ? Math.round(km) : Math.round(km / 5) * 5);

module.exports = { CITIES, PIN_PREFIXES, RADII, coordsOf, cityOfPin, distanceKm, parseNear, jobDistance, shownKm };
