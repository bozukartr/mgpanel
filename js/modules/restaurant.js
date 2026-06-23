/* StayOS — Restoran (POS) modülü · Faz 1.1: Ayarlar + Menü Yönetimi.
 * Standalone page (restaurant.html), app-shell içinde "Restoran" sekmesi.
 * Tek outlet. restConfig/{tenant} ayarlar, restMenu/{id} menü kalemleri. */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') return;

    const CFG_COL = 'restConfig';
    const MENU_COL = 'restMenu';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const $ = id => document.getElementById(id);
    function toast(msg, isErr) {
        const t = $('toast'); if (!t) return;
        t.textContent = msg; t.className = 'rst-toast show' + (isErr ? ' err' : '');
        setTimeout(() => { t.className = 'rst-toast'; }, 2600);
    }

    let cfg = { name: '', currency: '₺', vatRate: 10, vatMode: 'included', serviceCharge: 0, roomChargeEnabled: true, receiptHeader: '', receiptFooter: '' };
    let menu = [];
    let editingId = null;

    // ── Sub-tab navigation ─────────────────────────────────────
    function wireTabs() {
        const nav = $('rstSubnav');
        nav.addEventListener('click', e => {
            const b = e.target.closest('.rst-tab'); if (!b) return;
            const v = b.getAttribute('data-view');
            nav.querySelectorAll('.rst-tab').forEach(x => x.classList.toggle('active', x === b));
            document.querySelectorAll('.rst-view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
        });
    }

    // ── Settings (restConfig) ──────────────────────────────────
    function fillSettings() {
        $('cfgName').value = cfg.name || '';
        $('cfgCurrency').value = cfg.currency || '₺';
        $('cfgVat').value = (cfg.vatRate != null ? cfg.vatRate : 10);
        $('cfgVatMode').value = cfg.vatMode || 'included';
        $('cfgService').value = 0;
        $('cfgRoomCharge').checked = cfg.roomChargeEnabled !== false;
        $('cfgReceiptHeader').value = cfg.receiptHeader || '';
        $('cfgReceiptFooter').value = cfg.receiptFooter || '';
    }
    function loadConfig() {
        db.collection(CFG_COL).doc(TENANT_ID).get().then(doc => {
            if (doc.exists) cfg = Object.assign(cfg, doc.data());
            fillSettings();
        }).catch(err => console.error('restConfig load', err));
    }
    function saveConfig() {
        const data = {
            tenantId: TENANT_ID,
            name: ($('cfgName').value || '').trim().slice(0, 60),
            currency: ($('cfgCurrency').value || '₺').trim().slice(0, 4) || '₺',
            vatRate: Math.max(0, Math.min(100, parseInt($('cfgVat').value, 10) || 0)),
            vatMode: $('cfgVatMode').value === 'excluded' ? 'excluded' : 'included',
            serviceCharge: 0, // yasal: servis/kuver ücreti alınamaz
            roomChargeEnabled: $('cfgRoomCharge').checked,
            receiptHeader: ($('cfgReceiptHeader').value || '').trim().slice(0, 80),
            receiptFooter: ($('cfgReceiptFooter').value || '').trim().slice(0, 120),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        db.collection(CFG_COL).doc(TENANT_ID).set(data, { merge: true })
            .then(() => { cfg = Object.assign(cfg, data); toast('Ayarlar kaydedildi.'); })
            .catch(err => { console.error(err); toast('Kaydedilemedi.', true); });
    }

    // ── Menu (restMenu) ────────────────────────────────────────
    const STATION = { kitchen: 'Mutfak', bar: 'Bar' };
    function money(v) { const n = Number(v); return (cfg.currency || '₺') + (isNaN(n) ? '0' : n.toLocaleString('tr-TR')); }

    function categoriesOrdered() {
        const seen = [];
        menu.slice().sort(byOrder).forEach(i => { const c = i.category || 'Diğer'; if (!seen.includes(c)) seen.push(c); });
        return seen;
    }
    function byOrder(a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || '', 'tr'); }

    function renderMenu() {
        const wrap = $('menuList'); if (!wrap) return;
        const dl = $('miCatList'); if (dl) dl.innerHTML = categoriesOrdered().map(c => `<option value="${esc(c)}">`).join('');
        if (!menu.length) {
            wrap.innerHTML = `<div class="rst-empty">Henüz ürün yok.<br>“Örnek Menü Yükle” ile başlayabilir veya “Ürün Ekle” diyebilirsin.</div>`;
            return;
        }
        wrap.innerHTML = categoriesOrdered().map(cat => {
            const items = menu.filter(i => (i.category || 'Diğer') === cat).sort(byOrder);
            return `<div class="rst-cat">
                <h3>${esc(cat)} <span>${items.length}</span></h3>
                <div class="rst-items">${items.map(rowHtml).join('')}</div>
            </div>`;
        }).join('');
        wrap.querySelectorAll('[data-edit]').forEach(r => r.onclick = () => openModal(r.getAttribute('data-edit')));
    }
    function rowHtml(i) {
        const active = i.active !== false;
        const vat = (i.vatRate != null && i.vatRate !== '') ? i.vatRate + '% KDV' : '';
        const sub = [STATION[i.station] || 'Mutfak', vat].filter(Boolean).join(' · ');
        return `<div class="rst-item ${active ? '' : 'off'}" data-edit="${esc(i.id)}">
            <div class="rst-item-ic">${esc(i.icon || '🍽️')}</div>
            <div class="rst-item-b">
                <div class="rst-item-n">${esc(i.name)}</div>
                <div class="rst-item-s">${esc(sub)}</div>
            </div>
            <div class="rst-item-p">${esc(money(i.price))}</div>
            <span class="rst-flag ${active ? 'on' : 'no'}">${active ? 'Aktif' : 'Pasif'}</span>
        </div>`;
    }

    function openModal(id) {
        editingId = id || null;
        const it = id ? menu.find(x => x.id === id) : null;
        $('menuModalTitle').textContent = it ? 'Ürün Düzenle' : 'Ürün Ekle';
        $('miName').value = it ? (it.name || '') : '';
        $('miCategory').value = it ? (it.category || '') : '';
        $('miStation').value = it ? (it.station || 'kitchen') : 'kitchen';
        $('miPrice').value = it && it.price != null ? it.price : '';
        $('miVat').value = it && it.vatRate != null ? it.vatRate : '';
        $('miIcon').value = it ? (it.icon || '') : '';
        $('miPrep').value = it && it.prepMin ? it.prepMin : '';
        $('miDesc').value = it ? (it.description || '') : '';
        $('miActive').checked = it ? (it.active !== false) : true;
        $('menuDeleteBtn').style.display = it ? 'inline-flex' : 'none';
        $('menuModal').classList.add('open');
    }
    function closeModal() { $('menuModal').classList.remove('open'); editingId = null; }

    function saveMenu(e) {
        e.preventDefault();
        const name = $('miName').value.trim();
        const category = $('miCategory').value.trim();
        if (!name || !category) { toast('Ad ve kategori zorunlu.', true); return; }
        const vatStr = $('miVat').value;
        const data = {
            tenantId: TENANT_ID,
            name: name.slice(0, 80),
            category: category.slice(0, 40),
            station: $('miStation').value === 'bar' ? 'bar' : 'kitchen',
            price: Math.max(0, parseFloat($('miPrice').value) || 0),
            vatRate: vatStr === '' ? null : Math.max(0, Math.min(100, parseInt(vatStr, 10) || 0)),
            icon: ($('miIcon').value.trim() || '🍽️').slice(0, 4),
            prepMin: Math.max(0, parseInt($('miPrep').value, 10) || 0),
            description: $('miDesc').value.trim().slice(0, 160),
            active: $('miActive').checked,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        let p;
        if (editingId) {
            p = db.collection(MENU_COL).doc(editingId).update(data);
        } else {
            const maxOrder = menu.reduce((m, i) => Math.max(m, i.sortOrder || 0), 0);
            data.sortOrder = maxOrder + 10;
            data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            p = db.collection(MENU_COL).add(data);
        }
        p.then(() => { toast(editingId ? 'Ürün güncellendi.' : 'Ürün eklendi.'); closeModal(); })
            .catch(err => { console.error(err); toast('Kaydedilemedi.', true); });
    }
    function removeMenu() {
        if (!editingId) return;
        if (!confirm('Bu ürünü silmek istediğine emin misin?')) return;
        db.collection(MENU_COL).doc(editingId).delete()
            .then(() => { toast('Ürün silindi.'); closeModal(); })
            .catch(err => { console.error(err); toast('Silinemedi.', true); });
    }

    const DEFAULTS = [
        { category: 'Başlangıçlar', name: 'Mercimek Çorbası', icon: '🥣', price: 90, station: 'kitchen' },
        { category: 'Başlangıçlar', name: 'Mevsim Salata', icon: '🥗', price: 120, station: 'kitchen' },
        { category: 'Ana Yemekler', name: 'Izgara Köfte', icon: '🍖', price: 260, station: 'kitchen' },
        { category: 'Ana Yemekler', name: 'Tavuk Şiş', icon: '🍗', price: 240, station: 'kitchen' },
        { category: 'Ana Yemekler', name: 'Levrek Izgara', icon: '🐟', price: 380, station: 'kitchen' },
        { category: 'Tatlılar', name: 'Künefe', icon: '🍮', price: 150, station: 'kitchen' },
        { category: 'İçecekler', name: 'Su', icon: '💧', price: 30, station: 'bar' },
        { category: 'İçecekler', name: 'Ayran', icon: '🥛', price: 45, station: 'bar' },
        { category: 'İçecekler', name: 'Çay', icon: '🍵', price: 30, station: 'bar' },
        { category: 'İçecekler', name: 'Türk Kahvesi', icon: '☕', price: 60, station: 'bar' }
    ];
    function seedDefaults() {
        if (menu.length && !confirm('Örnek menü eklensin mi? (Aynı isimdekiler atlanır)')) return;
        const names = new Set(menu.map(i => (i.name || '').toLowerCase()));
        const batch = db.batch(); let n = 0;
        DEFAULTS.forEach((d, idx) => {
            if (names.has(d.name.toLowerCase())) return;
            const ref = db.collection(MENU_COL).doc();
            batch.set(ref, Object.assign({
                tenantId: TENANT_ID, vatRate: null, prepMin: 0, description: '', active: true,
                sortOrder: (idx + 1) * 10,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, d));
            n++;
        });
        if (!n) { toast('Eklenecek yeni ürün yok.'); return; }
        batch.commit().then(() => toast(n + ' ürün eklendi.')).catch(err => { console.error(err); toast('Yüklenemedi.', true); });
    }

    function listenMenu() {
        db.collection(MENU_COL).where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            menu = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
            renderMenu();
        }, err => console.error('menu listen', err));
    }

    // ── Boot ───────────────────────────────────────────────────
    function boot() {
        wireTabs();
        $('cfgSaveBtn').onclick = saveConfig;
        $('svcInfo').onclick = () => { const n = $('svcNote'); n.style.display = n.style.display === 'none' ? 'block' : 'none'; };
        $('menuAddBtn').onclick = () => openModal(null);
        $('menuSeedBtn').onclick = seedDefaults;
        $('menuModalClose').onclick = closeModal;
        $('menuForm').onsubmit = saveMenu;
        $('menuDeleteBtn').onclick = removeMenu;
        $('menuModal').addEventListener('click', e => { if (e.target === $('menuModal')) closeModal(); });
        const go = () => { loadConfig(); listenMenu(); };
        if (typeof auth !== 'undefined' && auth.onAuthStateChanged) auth.onAuthStateChanged(u => { if (u) go(); });
        else go();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
