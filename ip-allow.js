// Which addresses may use an API key (Step 190). A list holds single addresses
// and ranges (203.0.113.7, 203.0.113.0/24, 2001:db8::/48), IPv4 or IPv6; an empty
// list means any address. Ranges wider than a /8 (IPv4) or /32 (IPv6) are refused,
// because they would look like a restriction without being one.
const net = require('net');

const MAX_ENTRIES = 20;
const MIN_PREFIX = { 4: 8, 6: 32 };
const BITS = { 4: 32, 6: 128 };

// An IPv4 address carried in IPv6 form (::ffff:1.2.3.4, as Node reports it on a
// dual-stack socket) is the same address.
const plain = (ip) => String(ip == null ? '' : ip).trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

function parseEntry(raw) {
  const [address, prefix, extra] = plain(raw).split('/');
  const ip = plain(address);
  const version = net.isIP(ip);
  if (!version || extra !== undefined) return { error: `"${raw}" is not an address or range` };
  if (prefix === undefined) return { entry: ip };
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > BITS[version]) return { error: `"${raw}" has a range size that is not valid` };
  if (Number(prefix) < MIN_PREFIX[version]) return { error: `"${raw}" is too wide: use /${MIN_PREFIX[version]} or narrower` };
  return { entry: Number(prefix) === BITS[version] ? ip : `${ip}/${Number(prefix)}` };
}

// Text from a form (commas, spaces or new lines between entries) or an array.
function parseList(input) {
  const parts = (Array.isArray(input) ? input : String(input == null ? '' : input).split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean);
  const list = [];
  const errors = [];
  for (const raw of parts.slice(0, 200)) {
    const r = parseEntry(raw);
    if (r.error) errors.push(r.error);
    else if (!list.includes(r.entry)) list.push(r.entry);
  }
  if (list.length > MAX_ENTRIES) errors.push(`up to ${MAX_ENTRIES} addresses or ranges`);
  return { list, errors: errors.slice(0, 5) };
}

// Empty list: any address. Otherwise an unknown or unreadable address is refused.
function allowed(list, ip) {
  if (!list || !list.length) return true;
  const address = plain(ip);
  const version = net.isIP(address);
  if (!version) return false;
  const family = `ipv${version}`;
  const block = new net.BlockList();
  for (const entry of list) {
    const [base, prefix] = entry.split('/');
    const baseFamily = `ipv${net.isIP(base)}`;
    if (baseFamily !== family) continue;
    if (prefix === undefined) block.addAddress(base, family);
    else block.addSubnet(base, Number(prefix), family);
  }
  return block.check(address, family);
}

module.exports = { parseList, allowed, plain, MAX_ENTRIES };
