// api/compare.js — Proxy Mengantar: search alamat + bandingkan ongkir semua gudang
const { createClient } = require('@supabase/supabase-js');
const SEARCH_BASE = 'https://api-public.mengantar.com';

const COURIER_MAP = {
  JNE:       'JNE',
  JNT:       'JT',
  SICEPAT:   'SiCepat',
  ANTERAJA:  'anteraja',
  NINJA:     'Ninja',
  LION:      'lion',
  POS:       'pos',
  SAP:       'SAP',
  IDEXPRESS: 'iDexpress',
};

const COURIER_LABEL = {
  JNE:       'JNE',
  JNT:       'J&T Express',
  SICEPAT:   'SiCepat',
  ANTERAJA:  'Anteraja',
  NINJA:     'Ninja Xpress',
  LION:      'Lion Parcel',
  POS:       'POS Indonesia',
  SAP:       'SAP Express',
  IDEXPRESS: 'iDexpress',
};

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { mode, keyword, destination_id, kecamatan, kabupaten, provinsi, weight = 1 } = req.query;

  // ── MODE: search alamat tujuan (autocomplete) ─────────────────────────────
  if (mode === 'search') {
    if (!keyword) return res.status(400).json({ error: 'keyword wajib' });
    try {
      const r = await fetch(
        `${SEARCH_BASE}/api/public/csorder/address/search?keyword=${encodeURIComponent(keyword)}`,
        { headers: { Accept: 'application/json' } }
      );
      const json = await r.json();
      const list = (json?.data || []).slice(0, 10).map(d => ({
        id:        d._id,
        label:     `${d.SUBDISTRICT_NAME}, ${d.DISTRICT_NAME}, ${d.CITY_NAME}, ${d.PROVINCE_NAME}`,
        kecamatan: d.DISTRICT_NAME,
        kabupaten: d.CITY_NAME,
        provinsi:  d.PROVINCE_NAME,
        kelurahan: d.SUBDISTRICT_NAME,
      }));
      return res.json({ ok: true, data: list });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── MODE: list gudang aktif ───────────────────────────────────────────────
  if (mode === 'gudang') {
    try {
      const { data, error } = await sb().from('gudang').select('*').eq('aktif', true).order('id');
      if (error) throw error;
      return res.json({ ok: true, data: data || [] });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── MODE: bandingkan ongkir semua gudang ─────────────────────────────────
  if (!destination_id) return res.status(400).json({ error: 'destination_id wajib' });

  // Load gudang aktif
  let gudangs = [];
  try {
    const { data } = await sb().from('gudang').select('*').eq('aktif', true).order('id');
    gudangs = data || [];
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Gagal load gudang: ' + e.message });
  }

  if (!gudangs.length) return res.json({ ok: false, reason: 'Tidak ada gudang aktif.' });

  // Fetch ongkir dari semua gudang secara paralel
  const rawResults = await Promise.all(gudangs.map(async g => {
    try {
      const r = await fetch(
        `${SEARCH_BASE}/api/order/allEstimatePublic?origin_id=${g.origin_id}&destination_id=${destination_id}&weight=${weight}`,
        { headers: { Accept: 'application/json' } }
      );
      const json = await r.json();
      return { gudang: g, data: json?.data || {}, ok: !!json?.success };
    } catch {
      return { gudang: g, data: {}, ok: false };
    }
  }));

  // Skor kurir via getPerformancePublic (opsional)
  let scoreMap = {}; // { 'jne': { score, recommended } }
  const apiKey = process.env.MENGANTAR_API_KEY;
  if (apiKey && rawResults[0]?.ok) {
    try {
      const perfR = await fetch(
        `${SEARCH_BASE}/api/public/${apiKey}/order/getPerformancePublic`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ city: kabupaten || '', allEstimateData: rawResults[0].data }),
        }
      );
      const perfJson = await perfR.json();
      if (perfJson?.success) {
        const recommended = (perfJson.data?.recommended || '').toLowerCase();
        (perfJson.data?.couriers || []).forEach(c => {
          scoreMap[c.key.toLowerCase()] = { score: c.score, recommended: c.key.toLowerCase() === recommended };
        });
      }
    } catch { /* skor opsional, abaikan error */ }
  }

  // Susun per kurir
  const couriers = Object.entries(COURIER_MAP).map(([key, apiKey]) => {
    const prices = rawResults.map(r => {
      const dataLower = Object.fromEntries(
        Object.entries(r.data || {}).map(([k, v]) => [k.toLowerCase(), v])
      );
      const d = dataLower[apiKey.toLowerCase()];
      return {
        gudang:      r.gudang,
        price:       (!r.ok || !d || d.unsupported) ? null : (d.price ?? null),
        estimate:    d?.estimatedDate || d?.estimate_delivery || '—',
        unsupported: !r.ok || !d || !!d.unsupported,
      };
    });

    // Sort: termurah dulu, unsupported paling bawah
    prices.sort((a, b) => {
      if (a.price === null && b.price === null) return 0;
      if (a.price === null) return 1;
      if (b.price === null) return -1;
      return a.price - b.price;
    });

    const perf = scoreMap[apiKey.toLowerCase()] || null;
    const hasAny = prices.some(p => !p.unsupported);

    return {
      key,
      label:       COURIER_LABEL[key] || key,
      prices,
      hasAny,
      score:       perf?.score ?? null,
      recommended: perf?.recommended ?? false,
    };
  });

  // Hanya kurir yang didukung minimal 1 gudang
  const filtered = couriers.filter(c => c.hasAny);

  // Summary: gudang termurah keseluruhan (rata-rata semua kurir)
  const gudangTotals = {};
  gudangs.forEach(g => { gudangTotals[g.id] = { nama: g.nama, total: 0, count: 0 }; });
  filtered.forEach(c => {
    c.prices.forEach(p => {
      if (p.price !== null && gudangTotals[p.gudang.id]) {
        gudangTotals[p.gudang.id].total += p.price;
        gudangTotals[p.gudang.id].count++;
      }
    });
  });
  const summaries = Object.values(gudangTotals)
    .filter(g => g.count > 0)
    .map(g => ({ ...g, avg: Math.round(g.total / g.count) }))
    .sort((a, b) => a.avg - b.avg);

  return res.json({
    ok: true,
    destination: { id: destination_id, kecamatan, kabupaten, provinsi },
    couriers: filtered,
    gudangSummary: summaries,
  });
};
