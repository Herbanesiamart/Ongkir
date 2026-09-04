// api/track.js — Cek resi massal via Mengantar (endpoint dari CS Input)
const https = require('https');

const MENGANTAR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept':     'application/json',
  'Referer':    'https://www.mengantar.com/',
  'Origin':     'https://www.mengantar.com',
};

// Courier code yang diterima Mengantar (sama persis dengan CS Input)
const COURIER_LABEL = {
  JNE:       'JNE',
  JT:        'J&T Express',
  SiCepat:   'SiCepat',
  lion:      'Lion Parcel',
  SAP:       'SAP Express',
  anteraja:  'Anteraja',
  Ninja:     'Ninja Xpress',
  iDexpress: 'iDexpress',
  POS:       'POS Indonesia',
};

// Auto-detect kurir dari prefix nomor resi
function detectCourier(resi) {
  const r = resi.toUpperCase();
  if (/^(JD|JP|JE|JN|JT|CD|CG)/.test(r) && /^\d/.test(r.slice(2))) return null; // ambigu
  if (/^(JD|JP|JN)\d/.test(r))   return 'JNE';
  if (/^(JP\d|JD\d)/.test(r))    return 'JNE';
  if (/^(JNE)/.test(r))          return 'JNE';
  if (/^(JT|JTX)/.test(r) && r.length > 10) return 'JT';
  if (/^LP/.test(r))              return 'lion';
  if (/^(SC|SCP)/.test(r))       return 'SiCepat';
  if (/^(ANT|ANTJ|ANTB)/.test(r)) return 'anteraja';
  if (/^NX/.test(r))             return 'Ninja';
  if (/^(ID|IDX|IDEX)/.test(r))  return 'iDexpress';
  if (/^(SAP)/.test(r))          return 'SAP';
  if (/^(77|1D)/.test(r))        return 'POS';
  return null;
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: MENGANTAR_HEADERS }, (resp) => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: resp.statusCode, json: null, raw: body.slice(0, 300) }); }
      });
    }).on('error', reject);
  });
}

function normalizeStatus(raw) {
  if (!raw) return { label: 'Tidak Diketahui', type: 'unknown' };
  const s = raw.toLowerCase();
  if (s.includes('delivered') || s.includes('terkirim') || s.includes('diterima') || s.includes('sampai')) return { label: 'Terkirim', type: 'delivered' };
  if (s.includes('return') || s.includes('kembali') || s.includes('retur'))                                return { label: 'Retur', type: 'retur' };
  if (s.includes('failed') || s.includes('gagal') || s.includes('problem') || s.includes('hold') || s.includes('kendala')) return { label: 'Bermasalah', type: 'problem' };
  if (s.includes('out for delivery') || s.includes('antar') || s.includes('otw'))                         return { label: 'Dibawa Kurir', type: 'out_delivery' };
  if (s.includes('pickup') || s.includes('manifest') || s.includes('dijemput'))                           return { label: 'Dijemput', type: 'pickup' };
  if (s.includes('transit') || s.includes('process') || s.includes('dikirim') || s.includes('outbound') || s.includes('inbound') || s.includes('perjalanan')) return { label: 'Dalam Pengiriman', type: 'transit' };
  return { label: raw, type: 'transit' };
}

async function trackOne({ resi, courier }) {
  // Kalau kurir tidak diberikan → coba auto-detect
  const courierCode = courier || detectCourier(resi);
  if (!courierCode) {
    return { resi, ok: false, needCourier: true, error: 'Kurir tidak terdeteksi otomatis. Pilih kurir secara manual.' };
  }

  const url = `https://app.mengantar.com/api/order/getPublic?tracking_number=${encodeURIComponent(resi)}&courier=${encodeURIComponent(courierCode)}`;
  try {
    const { json } = await httpGetJson(url);
    if (!json) return { resi, ok: false, error: 'Tidak ada response dari Mengantar' };

    const d = json.data || json;
    const history = (d.history || d.manifest || d.tracks || []).map(h => ({
      time: h.date || h.time || h.created_at || h.datetime || '',
      desc: h.description || h.note || h.status_desc || h.message || h.status || '',
      loc:  h.location || h.city || h.pos || '',
    }));

    const rawStatus = d.status || d.last_status || history[0]?.desc || '';
    const norm = normalizeStatus(rawStatus);
    const latest = history[0] || {};

    if (!json.success && !history.length) {
      return { resi, ok: false, error: json.message || json.error || 'Resi tidak ditemukan' };
    }

    return {
      resi, ok: true,
      courier:      courierCode,
      courierLabel: COURIER_LABEL[courierCode] || courierCode,
      origin:       d.shipper_city || d.origin || '',
      destination:  d.receiver_city || d.destination || '',
      lastStatus:   rawStatus,
      statusType:   norm.type,
      statusLabel:  norm.label,
      lastTime:     latest.time || '',
      lastLoc:      latest.loc || '',
      history,
    };
  } catch (e) {
    return { resi, ok: false, error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  let items = req.body?.resi || [];
  if (!Array.isArray(items)) return res.status(400).json({ error: 'resi harus array' });

  // Support dua format: array of string, atau array of {resi, courier}
  items = items
    .map(r => typeof r === 'string'
      ? { resi: r.trim().toUpperCase(), courier: null }
      : { resi: String(r.resi || '').trim().toUpperCase(), courier: r.courier || null }
    )
    .filter(r => r.resi.length >= 5);

  // Deduplikasi by resi
  const seen = new Set();
  items = items.filter(r => { if (seen.has(r.resi)) return false; seen.add(r.resi); return true; });

  if (!items.length) return res.status(400).json({ error: 'Tidak ada nomor resi valid' });
  if (items.length > 30) return res.status(400).json({ error: 'Maksimal 30 resi sekaligus' });

  const results = await Promise.all(items.map(trackOne));
  return res.json({ ok: true, results });
};
