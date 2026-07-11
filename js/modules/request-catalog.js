/* Hotizy — Admin management for the guest self-service catalog (requestCatalog).
 *
 * Included on admin.html. Powers the "Hazır Talepler" tab: list items grouped by
 * category, add / edit / delete, toggle active, and seed a sensible default menu.
 * Tenant-scoped (TENANT_ID) and guarded by the same admin auth as the rest of the
 * page — the security rules also require an admin in the matching tenant.
 */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') return;

    const COL = 'requestCatalog';
    const CFG = 'guestConfig';
    let items = [];
    let editingId = null;
    let unsub = null;
    let cfg = { hotelName: '', showPrices: false, currency: '₺', requireVerification: false };

    // Default starter menu — 4 operational categories.
    const DEFAULTS = [
        { category: 'Temizlik', name: 'Oda Temizliği', icon: '🧹', eta: '30-45 dk', maxQty: 1, department: 'Housekeeping', availFrom: '09:00', availTo: '16:00' },
        { category: 'Temizlik', name: 'Havlu Değişimi', icon: '🧺', eta: '15-30 dk', department: 'Housekeeping' },
        { category: 'Temizlik', name: 'Çarşaf Değişimi', icon: '🛏️', eta: '30-45 dk', maxQty: 1, department: 'Housekeeping', availFrom: '09:00', availTo: '16:00' },
        { category: 'Temizlik', name: 'Çöp Toplama', icon: '🗑️', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Temizlik', name: 'Banyo Malzemeleri', icon: '🧴', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Ekstra Yastık', icon: '🛏️', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Ekstra Battaniye', icon: '🧣', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Terlik', icon: '🥿', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Bornoz', icon: '🥼', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Konfor', name: 'Askı', icon: '🧥', eta: '15 dk', department: 'Housekeeping' },
        { category: 'Yiyecek & İçecek', name: 'Su', icon: '💧', eta: '15 dk', department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Çay / Kahve', icon: '☕', eta: '15-20 dk', price: 60, department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Meyve Tabağı', icon: '🍎', eta: '20-30 dk', price: 120, department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Atıştırmalık', icon: '🍫', eta: '20 dk', price: 80, department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Meşrubat', icon: '🥤', eta: '20 dk', price: 70, department: 'Food & Beverage' },
        { category: 'Yiyecek & İçecek', name: 'Buz', icon: '🧊', eta: '15 dk', department: 'Food & Beverage' },
        { category: 'Teknik', name: 'Klima Sorunu', icon: '❄️', eta: '30 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'TV Sorunu', icon: '📺', eta: '30 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'Sıcak Su Yok', icon: '🚿', eta: '30 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'Wi-Fi Sorunu', icon: '📶', eta: '20 dk', department: 'Engineering' },
        { category: 'Teknik', name: 'Ampul Değişimi', icon: '💡', eta: '20 dk', department: 'Engineering' }
    ];

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const $ = id => document.getElementById(id);
    function toast(msg, isError) {
        const t = $('toast');
        if (!t) return;
        t.textContent = msg;
        t.className = 'toast-notification show' + (isError ? ' error' : '');
        setTimeout(() => { t.className = 'toast-notification'; }, 2600);
    }

    // ── Styles ─────────────────────────────────────────────────
    function injectStyles() {
        if ($('cat-admin-styles')) return;
        const css = `
        .cat-group { margin-bottom: 18px; }
        .cat-group h3 { font-size: 14px; font-weight: 800; color: #1e293b; margin: 0 0 10px;
            display: flex; align-items: center; gap: 8px; }
        .cat-group h3 .cat-count { font-size: 11px; font-weight: 700; color: #94a3b8; background: #f1f5f9;
            padding: 2px 8px; border-radius: 999px; }
        .cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
        .cat-row { display: flex; align-items: center; gap: 11px; background: #fff; border: 1px solid #e8edf2;
            border-radius: 12px; padding: 11px 12px; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
        .cat-row:hover { border-color: #c7d2fe; box-shadow: 0 4px 14px rgba(99,102,241,.1); }
        .cat-row.inactive { opacity: .55; }
        .cat-row .cat-emoji { width: 40px; height: 40px; border-radius: 10px; background: #eef2ff; flex-shrink: 0;
            display: flex; align-items: center; justify-content: center; font-size: 21px; }
        .cat-row .cat-body { flex: 1; min-width: 0; }
        .cat-row .cat-name { font-size: 14px; font-weight: 700; color: #1e293b; }
        .cat-row .cat-reco { color: #f59e0b; font-size: 12px; }
        .cat-row .cat-sub { font-size: 11.5px; color: #94a3b8; }
        .cat-row .cat-flag { font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 999px; }
        .cat-row .cat-flag.on { background: #f0fdf4; color: #16a34a; }
        .cat-row .cat-flag.off { background: #fef2f2; color: #dc2626; }
        .cat-subhead { font-size: 11.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px;
            color: #6366f1; margin: 12px 0 8px; display: flex; align-items: center; gap: 8px; }
        .cat-subhead::before { content: '↳'; color: #c7d2fe; font-weight: 700; }
        .cat-empty { text-align: center; color: #94a3b8; padding: 40px 20px; font-size: 14px; }
        .cat-qr { background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 10px; padding: 10px 12px;
            font-size: 12.5px; color: #475569; }
        .cat-qr code { background: #eef2ff; color: #4f46e5; padding: 2px 6px; border-radius: 5px; font-size: 12px; }
        .qr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 14px; }
        .qr-card { border: 1px solid #e8edf2; border-radius: 12px; padding: 12px; text-align: center; background: #fff; }
        .qr-card .qr-img { width: 100%; max-width: 150px; margin: 0 auto; line-height: 0; }
        .qr-card .qr-img img, .qr-card .qr-img canvas { width: 100% !important; height: auto !important; border-radius: 6px; }
        .qr-card .qr-room { font-weight: 800; font-size: 15px; margin-top: 9px; color: #1e293b; }
        .qr-card .qr-dl { margin-top: 5px; font-size: 12px; color: #2563eb; cursor: pointer; background: none; border: none; font-weight: 600; font-family: inherit; }`;
        const el = document.createElement('style');
        el.id = 'cat-admin-styles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    // ── Render ─────────────────────────────────────────────────
    function categoriesOrdered() {
        const seen = [];
        items.slice().sort(byOrder).forEach(i => {
            const c = i.category || 'Diğer';
            if (!seen.includes(c)) seen.push(c);
        });
        return seen;
    }
    function byOrder(a, b) {
        return (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || '', 'tr');
    }
    // Ordered, de-duplicated subcategories within a category ('' = no subcategory).
    function subcatsOrdered(cat) {
        const seen = [];
        items.filter(i => (i.category || 'Diğer') === cat).slice().sort(byOrder).forEach(i => {
            const s = (i.subcategory || '').trim();
            if (!seen.includes(s)) seen.push(s);
        });
        return seen;
    }
    function allSubcats() {
        const seen = [];
        items.slice().sort(byOrder).forEach(i => {
            const s = (i.subcategory || '').trim();
            if (s && !seen.includes(s)) seen.push(s);
        });
        return seen;
    }

    function render() {
        const wrap = $('catalogList');
        if (!wrap) return;
        // QR hint
        const hint = $('catalogQrHint');
        if (hint) {
            // Resolve guest-order.html relative to wherever the panel is served
            // (works on Firebase Hosting, github.io subpaths, etc.).
            let base;
            try { base = new URL('guest-order', location.href).href; }
            catch (e) { base = 'guest-order'; }
            const url = `${base}?tenant=${encodeURIComponent(TENANT_ID)}&room=ODA_NO`;
            hint.innerHTML = `<div class="cat-qr">📱 Misafir QR adresi: <code>${esc(url)}</code> — her oda için <code>ODA_NO</code> yerine oda numarasını yazıp QR oluşturun.</div>`;
        }
        // Category + subcategory datalists for the modal
        const dl = $('catCatOptions');
        if (dl) dl.innerHTML = categoriesOrdered().map(c => `<option value="${esc(c)}">`).join('');
        const dls = $('catSubOptions');
        if (dls) dls.innerHTML = allSubcats().map(s => `<option value="${esc(s)}">`).join('');

        if (!items.length) {
            wrap.innerHTML = `<div class="cat-empty">Henüz talep eklenmemiş.<br>“Varsayılanları Yükle” ile başlayabilir veya “Talep Ekle” diyebilirsiniz.</div>`;
            return;
        }
        wrap.innerHTML = categoriesOrdered().map(cat => {
            const catItems = items.filter(i => (i.category || 'Diğer') === cat);
            // Group the category's items by subcategory ('' = ungrouped, shown first).
            const subs = subcatsOrdered(cat);
            const blocks = subs.map(sub => {
                const rows = catItems.filter(i => (i.subcategory || '').trim() === sub).sort(byOrder).map(rowHtml).join('');
                const head = sub ? `<div class="cat-subhead">${esc(sub)}</div>` : '';
                return head + `<div class="cat-grid">${rows}</div>`;
            }).join('');
            return `<div class="cat-group">
                <h3>${esc(cat)} <span class="cat-count">${catItems.length}</span></h3>
                ${blocks}
            </div>`;
        }).join('');
        wrap.querySelectorAll('[data-edit]').forEach(r => r.onclick = () => openModal(r.dataset.edit));
    }

    function rowHtml(i) {
        const active = i.active !== false;
        const cur = (cfg && cfg.currency) || '₺';
        const priceTxt = i.price ? cur + Number(i.price).toLocaleString('tr-TR') : 'Ücretsiz';
        const avail = (i.availFrom && i.availTo) ? ('🕒 ' + i.availFrom + '–' + i.availTo) : '';
        const sub = [i.department || '—', priceTxt, avail].filter(Boolean).join(' · ');
        return `<div class="cat-row ${active ? '' : 'inactive'}" data-edit="${esc(i.id)}">
            <div class="cat-emoji">${esc(i.icon || '🛎️')}</div>
            <div class="cat-body">
                <div class="cat-name">${esc(i.name)}</div>
                <div class="cat-sub">${esc(sub)}</div>
            </div>
            <span class="cat-flag ${active ? 'on' : 'off'}">${active ? 'Aktif' : 'Pasif'}</span>
        </div>`;
    }

    // ── Modal ──────────────────────────────────────────────────
    function openModal(id) {
        editingId = id || null;
        const it = id ? items.find(x => x.id === id) : null;
        $('catalogModalTitle').textContent = it ? 'Talep Düzenle' : 'Talep Ekle';
        $('catName').value = it ? (it.name || '') : '';
        $('catCategory').value = it ? (it.category || '') : '';
        $('catSubcategory').value = it ? (it.subcategory || '') : '';
        $('catIcon').value = it ? (it.icon || '') : '';
        $('catDept').value = it ? (it.department || '') : '';
        $('catDesc').value = it ? (it.description || '') : '';
        $('catPrice').value = it && it.price ? it.price : '';
        $('catEta').value = it ? (it.eta || '') : '';
        $('catMaxQty').value = it && it.maxQty ? it.maxQty : '';
        $('catAvailFrom').value = it ? (it.availFrom || '') : '';
        $('catAvailTo').value = it ? (it.availTo || '') : '';
        $('catActive').checked = it ? (it.active !== false) : true;
        $('catalogDeleteBtn').style.display = it ? 'block' : 'none';
        $('catalogModal').style.display = 'flex';
    }
    function closeModal() {
        $('catalogModal').style.display = 'none';
        editingId = null;
    }

    function save(e) {
        e.preventDefault();
        const name = $('catName').value.trim();
        const category = $('catCategory').value.trim();
        if (!name || !category) { toast('Ad ve kategori zorunlu.', true); return; }
        const existing = editingId ? items.find(x => x.id === editingId) : null;
        const maxOrder = items.reduce((m, i) => Math.max(m, i.sortOrder || 0), 0);
        const price = Math.max(0, parseInt($('catPrice').value, 10) || 0);
        const data = {
            tenantId: TENANT_ID,
            name: name,
            category: category,
            subcategory: $('catSubcategory').value.trim().slice(0, 60),
            icon: ($('catIcon').value.trim() || '🛎️').slice(0, 8),
            department: $('catDept').value,
            description: $('catDesc').value.trim(),
            eta: $('catEta').value.trim().slice(0, 20),
            price: price,
            maxQty: Math.max(0, parseInt($('catMaxQty').value, 10) || 0),
            availFrom: $('catAvailFrom').value || '',
            availTo: $('catAvailTo').value || '',
            active: $('catActive').checked,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        let p;
        if (editingId) {
            p = db.collection(COL).doc(editingId).update(data);
        } else {
            data.sortOrder = maxOrder + 10;
            data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            p = db.collection(COL).add(data);
        }
        p.then(() => { toast(editingId ? 'Talep güncellendi.' : 'Talep eklendi.'); closeModal(); })
         .catch(err => { console.error(err); toast('Kaydedilemedi.', true); });
    }

    function remove() {
        if (!editingId) return;
        if (!confirm('Bu talebi silmek istediğinize emin misiniz?')) return;
        db.collection(COL).doc(editingId).delete()
            .then(() => { toast('Talep silindi.'); closeModal(); })
            .catch(err => { console.error(err); toast('Silinemedi.', true); });
    }

    function seedDefaults() {
        if (items.length && !confirm('Mevcut listeye varsayılan talepler eklensin mi? (Aynı isimdekiler atlanır)')) return;
        const existingNames = new Set(items.map(i => (i.name || '').toLowerCase()));
        const batch = db.batch();
        let n = 0;
        DEFAULTS.forEach((d, idx) => {
            if (existingNames.has(d.name.toLowerCase())) return;
            const ref = db.collection(COL).doc();
            batch.set(ref, Object.assign({
                tenantId: TENANT_ID,
                description: '',
                active: true,
                sortOrder: (idx + 1) * 10,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, d));
            n++;
        });
        if (!n) { toast('Eklenecek yeni talep yok.'); return; }
        batch.commit().then(() => toast(n + ' talep eklendi.')).catch(err => { console.error(err); toast('Yüklenemedi.', true); });
    }

    // ── Guest page settings (guestConfig) ──────────────────────
    // Optional hotel-info fields shown to guests on the QR page.
    const INFO_FIELDS = {
        cfgWelcome: 'welcome', cfgPhone: 'phone', cfgCheckout: 'checkoutTime',
        cfgWifiName: 'wifiName', cfgWifiPass: 'wifiPass', cfgBreakfast: 'breakfast', cfgAddress: 'address'
    };
    function loadConfig() {
        db.collection(CFG).doc(TENANT_ID).get().then(doc => {
            if (doc.exists) cfg = Object.assign(cfg, doc.data());
            const hn = $('cfgHotelName'), cur = $('cfgCurrency'), sp = $('cfgShowPrices'), rv = $('cfgRequireVerify');
            if (hn) hn.value = cfg.hotelName || '';
            if (cur) cur.value = cfg.currency || '₺';
            if (sp) sp.checked = !!cfg.showPrices;
            if (rv) rv.checked = !!cfg.requireVerification;
            const hi = $('cfgHeroImage'); if (hi) hi.value = cfg.heroImage || '';
            Object.keys(INFO_FIELDS).forEach(id => { const el = $(id); if (el) el.value = cfg[INFO_FIELDS[id]] || ''; });
            render();
        }).catch(err => console.error('config load failed', err));
    }
    function saveConfig() {
        cfg = {
            hotelName: ($('cfgHotelName').value || '').trim().slice(0, 60),
            currency: ($('cfgCurrency').value || '₺').trim().slice(0, 4) || '₺',
            showPrices: $('cfgShowPrices').checked,
            requireVerification: $('cfgRequireVerify').checked,
            heroImage: (($('cfgHeroImage') || {}).value || '').trim().slice(0, 500)
        };
        Object.keys(INFO_FIELDS).forEach(id => { const el = $(id); if (el) cfg[INFO_FIELDS[id]] = (el.value || '').trim().slice(0, 160); });
        db.collection(CFG).doc(TENANT_ID).set(Object.assign({ tenantId: TENANT_ID, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, cfg), { merge: true })
            .then(() => { toast('Ayarlar kaydedildi.'); render(); })
            .catch(err => { console.error(err); toast('Kaydedilemedi.', true); });
    }

    // ── Room QR generator ──────────────────────────────────────
    function roomUrl(room) {
        let base;
        try { base = new URL('guest-order', location.href).href; }
        catch (e) { base = 'guest-order'; }
        return base + '?tenant=' + encodeURIComponent(TENANT_ID) + '&room=' + encodeURIComponent(room);
    }
    // "101-110, 201, 305" -> ['101'..'110','201','305'] (deduped, max 200).
    function parseRooms(str) {
        const out = [], seen = Object.create(null);
        String(str || '').split(',').forEach(part => {
            part = part.trim();
            if (!part) return;
            const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
            if (m) {
                let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
                if (a > b) { const t = a; a = b; b = t; }
                for (let i = a; i <= b && out.length < 200; i++) { const r = String(i); if (!seen[r]) { seen[r] = 1; out.push(r); } }
            } else if (!seen[part]) { seen[part] = 1; out.push(part); }
        });
        return out;
    }
    function qrDataUrl(holder) {
        const c = holder.querySelector('canvas');
        if (c) { try { return c.toDataURL('image/png'); } catch (e) {} }
        const img = holder.querySelector('img');
        return img ? img.src : '';
    }
    async function genQRs() {
        const grid = $('qrGrid');
        if (!grid) return;
        // QR kütüphanesi tembel yüklenir (bkz. js/core/lazy-load.js) —
        // önceden admin sayfası açılışında eager iniyordu (hız denetimi).
        if (typeof QRCode === 'undefined' && typeof loadScriptOnce === 'function') {
            try { await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'); } catch (e) {}
        }
        if (typeof QRCode === 'undefined') { toast('QR kütüphanesi yüklenemedi.', true); return; }
        const rooms = parseRooms(($('qrRooms') || {}).value);
        if (!rooms.length) { toast('Lütfen oda numarası girin.', true); return; }
        grid.innerHTML = '';
        rooms.forEach(room => {
            const card = document.createElement('div'); card.className = 'qr-card';
            const holder = document.createElement('div'); holder.className = 'qr-img'; card.appendChild(holder);
            const label = document.createElement('div'); label.className = 'qr-room'; label.textContent = 'Oda ' + room; card.appendChild(label);
            const dl = document.createElement('button'); dl.className = 'qr-dl'; dl.type = 'button'; dl.textContent = 'PNG indir'; card.appendChild(dl);
            grid.appendChild(card);
            try { new QRCode(holder, { text: roomUrl(room), width: 300, height: 300, correctLevel: QRCode.CorrectLevel.M }); } catch (e) { console.error(e); }
            dl.onclick = () => { const u = qrDataUrl(holder); if (!u) return; const a = document.createElement('a'); a.href = u; a.download = 'oda-' + room + '-qr.png'; a.click(); };
        });
        const pb = $('qrPrintBtn'); if (pb) pb.style.display = 'inline-flex';
        toast(rooms.length + ' QR oluşturuldu.');
    }
    function printQRs() {
        const grid = $('qrGrid'); if (!grid) return;
        const cards = Array.prototype.slice.call(grid.querySelectorAll('.qr-card'));
        if (!cards.length) return;
        const hotel = (cfg && cfg.hotelName) ? cfg.hotelName : '';
        const items = cards.map(c => {
            const room = c.querySelector('.qr-room').textContent;
            const url = qrDataUrl(c.querySelector('.qr-img'));
            return `<div class="p-card"><img src="${url}"><div class="p-room">${esc(room)}</div>${hotel ? `<div class="p-hotel">${esc(hotel)}</div>` : ''}<div class="p-tip">Talep oluşturmak için okutun</div></div>`;
        }).join('');
        const w = window.open('', '_blank');
        if (!w) { toast('Açılır pencere engellendi. Lütfen izin verin.', true); return; }
        w.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Oda QR Kodları</title><style>'
            + '*{box-sizing:border-box;font-family:Arial,Helvetica,sans-serif}body{margin:0;padding:14px}'
            + '.p-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}'
            + '.p-card{border:1px solid #ddd;border-radius:10px;padding:16px;text-align:center;page-break-inside:avoid}'
            + '.p-card img{width:100%;max-width:240px;height:auto}'
            + '.p-room{font-size:22px;font-weight:800;margin-top:10px}'
            + '.p-hotel{font-size:13px;color:#444;margin-top:2px}'
            + '.p-tip{font-size:12px;color:#777;margin-top:6px}'
            + '</style></head><body><div class="p-grid">' + items + '</div>'
            + '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print();},350);}</scr' + 'ipt>'
            + '</body></html>');
        w.document.close();
    }

    // ── Listen ─────────────────────────────────────────────────
    function listen() {
        if (unsub) return;
        unsub = db.collection(COL).where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            items = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
            render();
        }, err => console.error('catalog listen failed', err));
    }

    // ── Boot ───────────────────────────────────────────────────
    function boot() {
        // Feature-gated module: if the hotel's plan doesn't include "Misafir
        // Talepleri" (superadmin toggle), drop the admin tab entirely.
        if (typeof moduleEnabled === 'function' && !moduleEnabled('guestOrders')) {
            const tab = document.querySelector('.adm-tab[data-view="catalog"]');
            if (tab) tab.remove();
            const view = $('view-catalog');
            if (view) view.remove();
            return;
        }
        injectStyles();
        $('catAddBtn') && ($('catAddBtn').onclick = () => openModal(null));
        $('catSeedBtn') && ($('catSeedBtn').onclick = seedDefaults);
        $('closeCatalogModal') && ($('closeCatalogModal').onclick = closeModal);
        $('catalogForm') && ($('catalogForm').onsubmit = save);
        $('catalogDeleteBtn') && ($('catalogDeleteBtn').onclick = remove);
        $('catCfgSave') && ($('catCfgSave').onclick = saveConfig);
        $('qrGenBtn') && ($('qrGenBtn').onclick = genQRs);
        $('qrPrintBtn') && ($('qrPrintBtn').onclick = printQRs);
        $('qrRooms') && $('qrRooms').addEventListener('keydown', e => { if (e.key === 'Enter') genQRs(); });
        const modal = $('catalogModal');
        if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
        auth.onAuthStateChanged(u => { if (u) { listen(); loadConfig(); } });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
