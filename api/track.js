// api/track.js — Cek resi via Mengantar API
const SEARCH_BASE = 'https://api-public.mengantar.com';

function normalizeStatus(raw) {
  if (!raw) return { label: 'Tidak Diketahui', type: 'unknown' };
  const s = raw.toLowerCase();
  if (s.includes('delivered') || s.includes('terkirim') || s.includes('diterima')) return { label: 'Terkirim', type: 'delivered' };
  if (s.includes('return') || s.includes('kembali'))                                return { label: 'Retur', type: 'retur' };
  if (s.includes('failed') || s.includes('gagal') || s.includes('problem') || s.includes('hold')) return { label: 'Bermasalah', type: 'problem' };
  if (s.includes('out for delivery') || s.includes('antar jemput'))                return { label: 'Dibawa Kurir', type: 'out_delivery' };
  if (s.includes('pickup') || s.includes('dijemput') || s.includes('manifest'))    return { label: 'Dijemput', type: 'pickup' };
  if (s.includes('transit') || s.includes('on process') || s.includes('dikirim') || s.includes('dalam perjalanan') || s.includes('outbound') || s.includes('inbound')) return { label: 'Dalam Pengiriman', type: 'transit' };
  return { label: raw, type: 'transit' };
}

async function tryFetch(url, opts = {}) {
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', ...opts.headers },
      method: opts.method || 'GET',
      body: opts.body,
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, ok: r.ok, json, text: text.slice(0, 500) };
  } catch (e) {
    return { status: 0, ok: false, json: null, error: e.message };
  }
}

async function trackOne(resi, debug = false) {
  const mKey = process.env.MENGANTAR_API_KEY || '';

  // Semua kandidat endpoint yang mungkin
  const attempts = [
    // Dengan API key (kalau ada)
    ...(mKey ? [
      { url: `${SEARCH_BASE}/api/public/${mKey}/order/tracking?resi=${encodeURIComponent(resi)}`, label: 'key/tracking?resi' },
      { url: `${SEARCH_BASE}/api/public/${mKey}/order/tracking?awb=${encodeURIComponent(resi)}`, label: 'key/tracking?awb' },
      { url: `${SEARCH_BASE}/api/public/${mKey}/order/track?resi=${encodeURIComponent(resi)}`, label: 'key/track?resi' },
    ] : []),
    // Tanpa key
    { url: `${SEARCH_BASE}/api/public/csorder/tracking?resi=${encodeURIComponent(resi)}`, label: 'csorder/tracking?resi' },
    { url: `${SEARCH_BASE}/api/public/csorder/tracking?awb=${encodeURIComponent(resi)}`, label: 'csorder/tracking?awb' },
    { url: `${SEARCH_BASE}/api/public/csorder/track?resi=${encodeURIComponent(resi)}`, label: 'csorder/track?resi' },
    { url: `${SEARCH_BASE}/api/order/tracking?resi=${encodeURIComponent(resi)}`, label: 'order/tracking?resi' },
    { url: `${SEARCH_BASE}/api/order/tracking?awb=${encodeURIComponent(resi)}`, label: 'order/tracking?awb' },
    { url: `${SEARCH_BASE}/api/public/order/tracking?resi=${encodeURIComponent(resi)}`, label: 'public/order/tracking?resi' },
  ];

  const logs = [];

  for (const attempt of attempts) {
    const res = await tryFetch(attempt.url);
    logs.push({ label: attempt.label, status: res.status, preview: res.text?.slice(0, 200) });

    if (!res.ok || !res.json) continue;
    const d = res.json;

    // Cek apakah response punya data tracking yang valid
    const data = d.data || d.result || d;
    const history = data.history || data.manifest || data.tracking || data.tracks || data.details || [];
    const rawStatus = data.status || data.last_status || data.latest_status || '';
    const hasData = history.length > 0 || rawStatus;

    if ((d.success || d.ok || d.status === true) && hasData) {
      const historyMapped = history.map(h => ({
        time: h.date || h.time || h.created_at || h.datetime || h.updated_at || '',
        desc: h.description || h.note || h.status_desc || h.message || h.detail || h.status || '',
        loc:  h.location || h.city || h.pos || '',
      }));

      const latest = historyMapped[0] || {};
      const norm = normalizeStatus(rawStatus || latest.desc);

      return {
        resi, ok: true,
        courier:     data.courier || data.courier_name || data.kurir || data.ekspedisi || '',
        origin:      data.shipper_city || data.origin || data.pengirim_kota || '',
        destination: data.receiver_city || data.destination || data.tujuan_kota || '',
        lastStatus:  rawStatus,
        statusType:  norm.type,
        statusLabel: norm.label,
        lastTime:    latest.time || '',
        lastLoc:     latest.loc || '',
        history:     historyMapped,
        ...(debug ? { _debug: logs } : {}),
      };
    }
  }

  return {
    resi, ok: false,
    error: 'Resi tidak ditemukan atau layanan tidak tersedia',
    ...(debug ? { _debug: logs } : {}),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  let resiList = req.body?.resi || [];
  const debug  = req.body?.debug === true;

  if (!Array.isArray(resiList)) return res.status(400).json({ error: 'resi harus array' });

  resiList = [...new Set(resiList.map(r => String(r).trim().toUpperCase()).filter(r => r.length >= 5))];
  if (!resiList.length) return res.status(400).json({ error: 'Tidak ada nomor resi valid' });
  if (resiList.length > 30) return res.status(400).json({ error: 'Maksimal 30 resi sekaligus' });

  const results = await Promise.all(resiList.map(r => trackOne(r, debug)));
  return res.json({ ok: true, results });
};
