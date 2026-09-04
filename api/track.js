// api/track.js — Cek resi massal via Mengantar API
const SEARCH_BASE = 'https://api-public.mengantar.com';

// Status normalization
function normalizeStatus(raw) {
  if (!raw) return { label: 'Tidak Diketahui', type: 'unknown' };
  const s = raw.toLowerCase();
  if (s.includes('delivered') || s.includes('terkirim') || s.includes('diterima')) return { label: 'Terkirim', type: 'delivered' };
  if (s.includes('return') || s.includes('kembali')) return { label: 'Retur', type: 'retur' };
  if (s.includes('failed') || s.includes('gagal') || s.includes('problem') || s.includes('hold')) return { label: 'Bermasalah', type: 'problem' };
  if (s.includes('pickup') || s.includes('dijemput') || s.includes('manifest')) return { label: 'Dijemput', type: 'pickup' };
  if (s.includes('transit') || s.includes('on process') || s.includes('dikirim') || s.includes('dalam perjalanan') || s.includes('outbound') || s.includes('inbound')) return { label: 'Dalam Pengiriman', type: 'transit' };
  if (s.includes('out for delivery') || s.includes('antar')) return { label: 'Dibawa Kurir', type: 'out_delivery' };
  return { label: raw, type: 'transit' };
}

async function trackOne(resi) {
  const mKey = process.env.MENGANTAR_API_KEY;

  // Coba endpoint dengan API key dulu, fallback ke public
  const urls = mKey
    ? [
        `${SEARCH_BASE}/api/public/${mKey}/order/tracking?resi=${encodeURIComponent(resi)}`,
        `${SEARCH_BASE}/api/public/csorder/tracking?resi=${encodeURIComponent(resi)}`,
      ]
    : [
        `${SEARCH_BASE}/api/public/csorder/tracking?resi=${encodeURIComponent(resi)}`,
        `${SEARCH_BASE}/api/order/tracking?resi=${encodeURIComponent(resi)}`,
      ];

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const json = await r.json();
      if (json?.success || json?.data) {
        const d = json.data || {};
        const history = (d.history || d.manifest || d.tracking || []).map(h => ({
          time:    h.date || h.time || h.created_at || '',
          desc:    h.description || h.note || h.status_desc || h.message || '',
          loc:     h.location || h.city || '',
        }));
        const latest = history[0] || {};
        const rawStatus = d.status || d.last_status || latest.desc || '';
        const norm = normalizeStatus(rawStatus);
        return {
          resi,
          ok: true,
          courier:    d.courier || d.courier_name || d.kurir || '',
          origin:     d.shipper_city || d.origin || '',
          destination: d.receiver_city || d.destination || '',
          lastStatus: rawStatus,
          statusType: norm.type,
          statusLabel: norm.label,
          lastTime:   latest.time || '',
          lastLoc:    latest.loc || '',
          history,
        };
      }
    } catch { /* coba URL berikutnya */ }
  }

  return { resi, ok: false, error: 'Resi tidak ditemukan atau layanan tidak tersedia' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let resiList = req.body?.resi || [];
  if (!Array.isArray(resiList)) return res.status(400).json({ error: 'resi harus array' });

  // Bersihkan & deduplikasi
  resiList = [...new Set(resiList.map(r => String(r).trim().toUpperCase()).filter(r => r.length >= 5))];
  if (!resiList.length) return res.status(400).json({ error: 'Tidak ada nomor resi valid' });
  if (resiList.length > 30) return res.status(400).json({ error: 'Maksimal 30 resi sekaligus' });

  const results = await Promise.all(resiList.map(trackOne));
  return res.json({ ok: true, results });
};
