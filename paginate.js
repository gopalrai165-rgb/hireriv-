// Splits a list into pages and builds the pager links, keeping every other
// query parameter (filters, sort, tab) so moving between pages keeps the view.

function paginate(list, { page, size, query = {}, path = '' }) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages);
  const start = (current - 1) * size;
  const urlFor = (n) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (k === 'page' || k === 'msg' || v === undefined || v === '') continue;
      // Repeated filters (several categories) keep every value.
      if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
      else params.set(k, String(v));
    }
    if (n > 1) params.set('page', String(n));
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  };
  // First, last, and two either side of the current page, with gaps marked.
  const links = [];
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - current) <= 2) links.push({ n, url: urlFor(n), current: n === current });
    else if (links[links.length - 1] && !links[links.length - 1].gap) links.push({ gap: true });
  }
  return {
    rows: list.slice(start, start + size),
    pager: { page: current, pages, total, size, from: total ? start + 1 : 0, to: Math.min(start + size, total), links, prev: current > 1 ? urlFor(current - 1) : '', next: current < pages ? urlFor(current + 1) : '', urlFor },
  };
}

module.exports = { paginate };
