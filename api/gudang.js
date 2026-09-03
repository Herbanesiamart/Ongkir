// api/gudang.js — CRUD gudang (password protected)
const { createClient } = require('@supabase/supabase-js');
const SEARCH_BASE = 'https://api-public.mengantar.com';

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function checkAuth(req) {
  const key = req.headers['x-admin-key'] || req.query.key || '';
  const expected = process.env.ADMIN_KEY || 'Sukses2023';
  return key === expected;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // ── GET: list semua gudang ─────────────────────────────────────────────────
  if (req.method === 'GET' && req.query.mode !== 'search') {
    if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { data, error } = await sb().from('gudang').select('*').order('id');
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, data });
  }

  // ── GET mode=search: cari lokasi gudang (origin) ───────────────────────────
  if (req.method === 'GET' && req.query.mode === 'search') {
    if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    const keyword = (req.query.keyword || '').trim();
    if (!keyword) return res.status(400).json({ error: 'keyword wajib' });
    try {
      const r = await fetch(
        `${SEARCH_BASE}/api/public/csorder/address/search?keyword=${encodeURIComponent(keyword)}`,
        { headers: { Accept: 'application/json' } }
      );
      const json = await r.json();
      const list = (json?.data || []).slice(0, 10).map(d => ({
        origin_id: d._id,
        label: `${d.SUBDISTRICT_NAME}, ${d.DISTRICT_NAME}, ${d.CITY_NAME}, ${d.PROVINCE_NAME}`,
        kota: d.CITY_NAME,
      }));
      return res.json({ ok: true, data: list });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  // ── POST: tambah gudang ───────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { nama, kota, origin_id, is_default } = req.body || {};
    if (!nama || !kota || !origin_id) return res.status(400).json({ error: 'nama, kota, origin_id wajib' });

    if (is_default) {
      // Unset default yang lama
      await sb().from('gudang').update({ is_default: false }).eq('is_default', true);
    }

    const { data, error } = await sb().from('gudang').insert({
      nama, kota, origin_id,
      is_default: !!is_default,
      aktif: true,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, data });
  }

  // ── PATCH: update gudang ─────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id wajib di query' });
    const body = req.body || {};

    if (body.is_default === true) {
      await sb().from('gudang').update({ is_default: false }).eq('is_default', true);
    }

    const { data, error } = await sb().from('gudang').update(body).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, data });
  }

  // ── DELETE: hapus gudang ──────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id wajib di query' });
    const { error } = await sb().from('gudang').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
