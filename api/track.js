// api/track.js — Cek resi massal via Mengantar (sama persis dengan CS Input)
const https = require('https');

const MENGANTAR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept':     'application/json',
  'Referer':    'https://www.mengantar.com/',
  'Origin':     'https://www.mengantar.com',
};

const COURIER_LABEL = {
  JNE: 'JNE', JT: 'J&T Express', SiCepat: 'SiCepat', lion: 'Lion Parcel',
  SAP: 'SAP Express', anteraja: 'Anteraja', Ninja: 'Ninja Xpress',
  iDexpress: 'iDexpress', POS: 'POS Indonesia',
};

function detectCourier(resi) {
  const r = resi.toUpperCase();
  if (/^JNE/.test(r))             return 'JNE';
  if (/^(JD|JP)\d/.test(r))       return 'JNE';
  if (/^LP/.test(r))              return 'lion';
  if (/^(SC|SCP)/.test(r))        return 'SiCepat';
  if (/^(ANT|ANTJ|ANTB)/.test(r)) return 'anteraja';
  if (/^NX/.test(r))              return 'Ninja';
  if (/^(IDX|IDEX)/.test(r))      return 'iDexpress';
  if (/^SAP/.test(r))             return 'SAP';
  if (/^(77|1D)/.test(r))         return 'POS';
  return null;
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: MENGANTAR_HEADERS }, (resp) => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

// Sama persis dengan _trNormalizeMengantar di CS Input
function normalizeMengantar(json) {
  if (!json || !json.success || !json.data) return null;
  const d = json.data;
  const history = Array.isArray(d.history) ? d.history : [];
  const entries = history.map(h => ({
    desc:         [h.desc, h.code].filter(Boolean).join(' '),
    descOnly:     h.desc || '',
    code:         h.code || null,
    place:        h.counter_name || h.city_name || null,
    receivedBy:   (h.receiver || '').trim() || null,
    group:        h.type?.group || null,
    tag:          h.type?.tag   || null,
    reasonDelivery: null,
  }));
  return {
    statusCategory: d.statusCategory || d.status || '',
    entries,
    rawHistory: history,
    receiver:   d.RECEIVER_NAME || null,
    city:       d.RECEIVER_CITY || null,
  };
}

function isPickupPhase(e) { return !!(e && e.code && /pickup/i.test(e.code)); }
function isSelfReceipt(e) {
  if (!e || !e.place) return false;
  const m = /diterima oleh\s+(.+)/i.exec(e.descOnly || '');
  if (!m) return false;
  const norm = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return norm(m[1]) === norm(e.place);
}
function hasReceivedBy(e) { return !!(e && e.receivedBy); }

// Sama persis dengan trMapTrackingStage di CS Input
function mapStage({ resi, statusCategory, entries }) {
  if (!resi) return { stage: 'MENUNGGU_RESI', step: 1 };
  const cat = (statusCategory || '').toUpperCase();
  const arr = Array.isArray(entries) ? entries : [];
  const latest = arr.length ? arr[arr.length - 1] : null;
  const latestDesc = (latest?.desc || '').toLowerCase();
  let reachedStep = 2;
  arr.forEach(e => {
    if (isPickupPhase(e)) return;
    const d = (e.desc || '').toLowerCase();
    if (/sedang diantar|dalam pengantaran|out for delivery|kurir menuju|\botw\b|akan dikirim ke alamat penerima|with delivery courier|delivery courier|diantar ke alamat|on delivery|1st attempt|2nd attempt|percobaan/i.test(d)) reachedStep = Math.max(reachedStep, 4);
    else if (e.atDestination || /kota tujuan|gudang tujuan|tiba di kota|received at destination|received at warehouse|process and forward|inbound|sti-dest/i.test(d)) reachedStep = Math.max(reachedStep, 3);
  });

  let stage;
  if (cat.includes('RETUR') || cat.includes('RETURN') || arr.some(e => /retur|dikembalikan|\brts\b|\brto\b|return to sender/i.test(e.desc || ''))) {
    stage = 'RETUR';
  } else if (cat === 'DELIVERED' || (/diterima oleh|\bdelivered\b|\bpod\b/.test(latestDesc) && !isSelfReceipt(latest)) || hasReceivedBy(latest)) {
    stage = 'SAMPAI';
  } else {
    const hasStructuredProblem = arr.some(e => !isPickupPhase(e) && (e.group === 'UNDELIVERED' || e.tag === 'actionRequired' || !!e.reasonDelivery));
    if (hasStructuredProblem || arr.some(e => !isPickupPhase(e) && /gagal|kendala|bermasalah|problematic|tidak ditemukan|alamat tidak (lengkap|dikenal)|tidak ada orang|tidak ditempat|tidak dihuni|menunggu konfirmasi|disimpan di gudang|ditolak|pindah alamat|box undel/i.test(e.desc || ''))) {
      stage = 'BERMASALAH';
    } else if (reachedStep >= 4) { stage = 'OTW';
    } else if (reachedStep >= 3) { stage = 'KOTA_TUJUAN';
    } else { stage = 'DIKIRIM'; }
  }
  return { stage, step: stage === 'SAMPAI' ? 5 : reachedStep };
}

async function trackOne({ resi, courier }) {
  const courierCode = courier || detectCourier(resi);
  if (!courierCode) {
    return { resi, ok: false, needCourier: true, error: 'Kurir tidak terdeteksi otomatis. Pilih kurir secara manual.' };
  }

  try {
    const url  = `https://app.mengantar.com/api/order/getPublic?tracking_number=${encodeURIComponent(resi)}&courier=${encodeURIComponent(courierCode)}`;
    const json = await httpGetJson(url);
    const norm = normalizeMengantar(json);

    if (!norm) {
      return { resi, ok: false, error: json?.message || json?.error || 'Resi tidak ditemukan' };
    }

    const { stage, step } = mapStage({ resi, ...norm });

    return {
      resi, ok: true,
      courier:      courierCode,
      courierLabel: COURIER_LABEL[courierCode] || courierCode,
      receiver:     norm.receiver,
      city:         norm.city,
      stage, step,
      history:      norm.rawHistory, // raw dari Mengantar, oldest first
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

  items = items
    .map(r => typeof r === 'string'
      ? { resi: r.trim().toUpperCase(), courier: null }
      : { resi: String(r.resi || '').trim().toUpperCase(), courier: r.courier || null }
    )
    .filter(r => r.resi.length >= 5);

  const seen = new Set();
  items = items.filter(r => { if (seen.has(r.resi)) return false; seen.add(r.resi); return true; });

  if (!items.length) return res.status(400).json({ error: 'Tidak ada nomor resi valid' });

  const results = await Promise.all(items.map(trackOne));
  return res.json({ ok: true, results });
};
