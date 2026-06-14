/* StayOS — Admin management for the guest self-service catalog (requestCatalog).
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
        { category: 'Temizlik', name: 'Oda Temizliği', icon: '🧹', eta: '30-45 dk', department: 'Housekeeping' },
        { category: 'Temizlik', name: 'Havlu Değişimi', icon: '🧺', eta: '15-30 dk', department: 'Housekeeping' },
        { category: 'Temizlik', name: 'Çarşaf Değişimi', icon: '🛏️', eta: '30-45 dk', department: 'Housekeeping' },
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
        .cat-empty { text-align: center; color: #94a3b8; padding: 40px 20px; font-size: 14px; }
        .cat-qr { background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 10px; padding: 10px 12px;
            font-size: 12.5px; color: #475569; }
        .cat-qr code { background: #eef2ff; color: #4f46e5; padding: 2px 6px; border-radius: 5px; font-size: 12px; }`;
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

    function render() {
        const wrap = $('catalogList');
        if (!wrap) return;
        // QR hint
        const hint = $('catalogQrHint');
        if (hint) {
            // Resolve guest-order.html relative to wherever the panel is served
            // (works on Firebase Hosting, github.io subpaths, etc.).
            let base;
            try { base = new URL('guest-order.html', location.href).href; }
            catch (e) { base = 'guest-order.html'; }
            const url = `${base}?tenant=${encodeURIComponent(TENANT_ID)}&room=ODA_NO`;
            hint.innerHTML = `<div class="cat-qr">📱 Misafir QR adresi: <code>${esc(url)}</code> — her oda için <code>ODA_NO</code> yerine oda numarasını yazıp QR oluşturun.</div>`;
        }
        // Category datalist for the modal
        const dl = $('catCatOptions');
        if (dl) dl.innerHTML = categoriesOrdered().map(c => `<option value="${esc(c)}">`).join('');

        if (!items.length) {
            wrap.innerHTML = `<div class="cat-empty">Henüz talep eklenmemiş.<br>“Varsayılanları Yükle” ile başlayabilir veya “Talep Ekle” diyebilirsiniz.</div>`;
            return;
        }
        wrap.innerHTML = categoriesOrdered().map(cat => {
            const rows = items.filter(i => (i.category || 'Diğer') === cat).sort(byOrder).map(rowHtml).join('');
            const count = items.filter(i => (i.category || 'Diğer') === cat).length;
            return `<div class="cat-group">
                <h3>${esc(cat)} <span class="cat-count">${count}</span></h3>
                <div class="cat-grid">${rows}</div>
            </div>`;
        }).join('');
        wrap.querySelectorAll('[data-edit]').forEach(r => r.onclick = () => openModal(r.dataset.edit));
    }

    function rowHtml(i) {
        const active = i.active !== false;
        const cur = (cfg && cfg.currency) || '₺';
        const priceTxt = i.price ? cur + Number(i.price).toLocaleString('tr-TR') : 'Ücretsiz';
        const sub = [i.department || '—', priceTxt].join(' · ');
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
        $('catIcon').value = it ? (it.icon || '') : '';
        $('catDept').value = it ? (it.department || '') : '';
        $('catDesc').value = it ? (it.description || '') : '';
        $('catPrice').value = it && it.price ? it.price : '';
        $('catEta').value = it ? (it.eta || '') : '';
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
            icon: ($('catIcon').value.trim() || '🛎️').slice(0, 8),
            department: $('catDept').value,
            description: $('catDesc').value.trim(),
            eta: $('catEta').value.trim().slice(0, 20),
            price: price,
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
    function loadConfig() {
        db.collection(CFG).doc(TENANT_ID).get().then(doc => {
            if (doc.exists) cfg = Object.assign(cfg, doc.data());
            const hn = $('cfgHotelName'), cur = $('cfgCurrency'), sp = $('cfgShowPrices'), rv = $('cfgRequireVerify');
            if (hn) hn.value = cfg.hotelName || '';
            if (cur) cur.value = cfg.currency || '₺';
            if (sp) sp.checked = !!cfg.showPrices;
            if (rv) rv.checked = !!cfg.requireVerification;
            render();
        }).catch(err => console.error('config load failed', err));
    }
    function saveConfig() {
        cfg = {
            hotelName: ($('cfgHotelName').value || '').trim().slice(0, 60),
            currency: ($('cfgCurrency').value || '₺').trim().slice(0, 4) || '₺',
            showPrices: $('cfgShowPrices').checked,
            requireVerification: $('cfgRequireVerify').checked
        };
        db.collection(CFG).doc(TENANT_ID).set(Object.assign({ tenantId: TENANT_ID, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, cfg), { merge: true })
            .then(() => { toast('Ayarlar kaydedildi.'); render(); })
            .catch(err => { console.error(err); toast('Kaydedilemedi.', true); });
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
        const modal = $('catalogModal');
        if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
        auth.onAuthStateChanged(u => { if (u) { listen(); loadConfig(); } });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
