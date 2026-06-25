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
            renderView(v);
        });
        const kf = $('kdsFilter');
        if (kf) kf.addEventListener('click', e => {
            const b = e.target.closest('.rst-kds-fbtn'); if (!b) return;
            kdsFilter = b.getAttribute('data-st');
            kf.querySelectorAll('.rst-kds-fbtn').forEach(x => x.classList.toggle('active', x === b));
            renderKDS();
        });
    }

    // Aktif sekmeyi taze veriyle render et (modül içi işlemler sekme değiştirmeden yansısın).
    function renderView(v) {
        if (v === 'floor') renderFloor();
        else if (v === 'kds') renderKDS();
        else if (v === 'stock') renderStock();
        else if (v === 'menu') renderMenu();
        else if (v === 'folio') renderFolio();
        else if (v === 'archive') loadArchive();
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
    function money(v) {
        const n = Number(v);
        return (cfg.currency || '₺') + (isNaN(n) ? '0' : n.toLocaleString('tr-TR', { maximumFractionDigits: 2 }));
    }
    function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
    const loggedUser = (typeof localStorage !== 'undefined' && localStorage.getItem('hotelUsername')) || 'Personel';

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
    function marginPct(i) {
        const p = Number(i.price) || 0, c = Number(i.cost) || 0;
        if (p <= 0 || c <= 0) return null;
        return Math.round((p - c) / p * 100);
    }
    function stockState(i) {
        if (!i.trackStock) return null;
        const s = Number(i.stock) || 0, min = Number(i.stockMin) || 0;
        if (s <= 0) return { cls: 'out', label: 'Tükendi' };
        if (min > 0 && s <= min) return { cls: 'low', label: 'Az: ' + s };
        return { cls: 'ok', label: 'Stok: ' + s };
    }
    function rowHtml(i) {
        const active = i.active !== false;
        const vat = (i.vatRate != null && i.vatRate !== '') ? i.vatRate + '% KDV' : '';
        const mp = marginPct(i);
        const sub = [STATION[i.station] || 'Mutfak', vat, (mp != null ? 'Maliyet ' + money(i.cost) + ' · Kâr %' + mp : '')].filter(Boolean).join(' · ');
        const st = stockState(i);
        return `<div class="rst-item ${active ? '' : 'off'}" data-edit="${esc(i.id)}">
            <div class="rst-item-b">
                <div class="rst-item-n">${esc(i.name)}</div>
                <div class="rst-item-s">${esc(sub)}</div>
            </div>
            ${st ? `<span class="rst-stk ${st.cls}">${esc(st.label)}</span>` : ''}
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
        $('miCost').value = it && it.cost != null ? it.cost : '';
        $('miVat').value = it && it.vatRate != null ? it.vatRate : '';
        $('miPrep').value = it && it.prepMin ? it.prepMin : '';
        $('miDesc').value = it ? (it.description || '') : '';
        $('miTrackStock').checked = it ? !!it.trackStock : false;
        $('miStock').value = it && it.stock != null ? it.stock : '';
        $('miStockMin').value = it && it.stockMin != null ? it.stockMin : '';
        $('miStockRow').style.display = $('miTrackStock').checked ? '' : 'none';
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
            cost: Math.max(0, parseFloat($('miCost').value) || 0),
            vatRate: vatStr === '' ? null : Math.max(0, Math.min(100, parseInt(vatStr, 10) || 0)),
            prepMin: Math.max(0, parseInt($('miPrep').value, 10) || 0),
            description: $('miDesc').value.trim().slice(0, 160),
            trackStock: $('miTrackStock').checked,
            stock: $('miTrackStock').checked ? Math.max(0, parseInt($('miStock').value, 10) || 0) : 0,
            stockMin: Math.max(0, parseInt($('miStockMin').value, 10) || 0),
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
            if ($('view-stock') && $('view-stock').classList.contains('active')) renderStock();
            if ($('posOverlay') && $('posOverlay').classList.contains('open')) renderPosMenu();
        }, err => console.error('menu listen', err));
    }

    // ── Stok / Maliyet ──────────────────────────────────────────
    function decrementStock(items) {
        const dec = {};
        (items || []).forEach(l => {
            if (!l.menuId) return;
            const mi = menu.find(m => m.id === l.menuId);
            if (mi && mi.trackStock) dec[l.menuId] = (dec[l.menuId] || 0) + (Number(l.qty) || 0);
        });
        const ids = Object.keys(dec);
        if (!ids.length) return;
        const batch = db.batch();
        ids.forEach(id => batch.update(db.collection(MENU_COL).doc(id), {
            stock: firebase.firestore.FieldValue.increment(-dec[id]),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }));
        batch.commit().catch(err => console.error('stock', err));
    }
    function renderStock() {
        const wrap = $('stockList'); if (!wrap) return;
        const kpi = $('stockKpis');
        const tracked = menu.filter(i => i.trackStock).sort(byOrder);
        if (!tracked.length) {
            if (kpi) kpi.innerHTML = '';
            wrap.innerHTML = `<div class="rst-empty">Stok takibi açık ürün yok.<br>Menü sekmesinden bir ürünü düzenleyip “Stok takibi”ni açın.</div>`;
            return;
        }
        const lowCount = tracked.filter(i => { const s = Number(i.stock) || 0, m = Number(i.stockMin) || 0; return s <= 0 || (m > 0 && s <= m); }).length;
        const value = round2(tracked.reduce((s, i) => s + (Number(i.stock) || 0) * (Number(i.cost) || 0), 0));
        if (kpi) kpi.innerHTML = [['Takipli Ürün', tracked.length], ['Kritik / Tükenen', lowCount], ['Stok Değeri', money(value)]]
            .map(([l, v]) => `<div class="rst-kpi"><span class="v">${esc(v)}</span><span class="l">${esc(l)}</span></div>`).join('');
        wrap.innerHTML = tracked.map(i => {
            const st = stockState(i);
            return `<div class="rst-stock-row">
                <div class="rst-stock-main">
                    <div class="rst-stock-n">${esc(i.name)}</div>
                    <div class="rst-stock-meta">${esc(i.category || 'Diğer')}${i.cost ? ' · Maliyet ' + esc(money(i.cost)) : ''}${i.stockMin ? ' · Kritik ' + esc(i.stockMin) : ''}</div>
                </div>
                <span class="rst-stk ${st.cls}">${esc(st.label)}</span>
                <div class="rst-stock-act">
                    <input type="number" min="1" step="1" class="rst-stock-in" data-sin="${esc(i.id)}" placeholder="adet">
                    <button type="button" class="rst-btn ghost" data-sadd="${esc(i.id)}">Mal Girişi</button>
                    <button type="button" class="rst-btn ghost" data-sset="${esc(i.id)}">Sayım</button>
                </div>
            </div>`;
        }).join('');
        wrap.querySelectorAll('[data-sadd]').forEach(b => b.onclick = () => stockEntry(b.getAttribute('data-sadd'), false));
        wrap.querySelectorAll('[data-sset]').forEach(b => b.onclick = () => stockEntry(b.getAttribute('data-sset'), true));
    }
    function stockEntry(id, isSet) {
        const inp = document.querySelector('.rst-stock-in[data-sin="' + id + '"]');
        const v = parseInt(inp && inp.value, 10);
        if (isNaN(v) || v < 0) { toast('Geçerli adet girin.', true); return; }
        const upd = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
        upd.stock = isSet ? v : firebase.firestore.FieldValue.increment(v);
        db.collection(MENU_COL).doc(id).update(upd)
            .then(() => toast(isSet ? 'Stok sayımı güncellendi.' : 'Mal girişi yapıldı.'))
            .catch(err => { console.error(err); toast('İşlem başarısız.', true); });
        if (inp) inp.value = '';
    }

    // ════════════════════════════════════════════════════════════
    //  SALON (masalar) + POS (sipariş / adisyon)
    // ════════════════════════════════════════════════════════════
    const CHK_COL = 'restChecks';
    let openChecks = [];        // status 'open'|'sent' (açık adisyonlar)
    let editingCheckId = null;  // checkModal düzenleme hedefi (null = yeni)
    let currentCheck = null;    // POS'ta düzenlenen adisyon
    let posCat = '';
    let posSearch = '';
    let selectedLineId = null;  // POS'ta seçili kalem (bağlamsal işlem çubuğu)
    function tsToDate(v) {
        if (!v) return null;
        if (v.toDate) { try { return v.toDate(); } catch (e) { return null; } }
        if (v.seconds) return new Date(v.seconds * 1000);
        if (typeof v === 'number') return new Date(v);
        return null;
    }

    // ── Totals (KDV dahil/hariç, kalem bazlı oran) ─────────────
    function computeTotals(items) {
        const mode = cfg.vatMode || 'included';
        let subtotal = 0, vat = 0, total = 0;
        (items || []).forEach(it => {
            const rate = (it.vatRate != null && it.vatRate !== '') ? Number(it.vatRate) : (Number(cfg.vatRate) || 0);
            const line = (it.ikram ? 0 : (Number(it.unitPrice) || 0)) * (it.qty || 1);
            if (mode === 'included') {
                const lvat = rate > 0 ? line * rate / (100 + rate) : 0;
                vat += lvat; subtotal += line - lvat; total += line;
            } else {
                const lvat = line * rate / 100;
                subtotal += line; vat += lvat; total += line + lvat;
            }
        });
        return { subtotal: round2(subtotal), vat: round2(vat), total: round2(total) };
    }

    // ── Açık adisyonlar (Micros tarzı: masa no + kişi ile aç) ──
    function chkByOrder(a, b) { return String(a.tableName || '').localeCompare(String(b.tableName || ''), 'tr', { numeric: true }); }
    function sectionsOfChecks() {
        const seen = [];
        openChecks.forEach(c => { const s = (c.section || 'Genel'); if (!seen.includes(s)) seen.push(s); });
        return seen.sort((a, b) => a.localeCompare(b, 'tr'));
    }
    function elapsedMin(c) { const t = tsToDate(c.openedAt); return t ? Math.floor((Date.now() - t.getTime()) / 60000) : 0; }
    function elapsed(c) {
        const m = elapsedMin(c);
        if (m < 1) return 'az önce';
        if (m < 60) return m + ' dk';
        return Math.floor(m / 60) + ' sa ' + (m % 60) + ' dk';
    }
    function ageClass(c) { const m = elapsedMin(c); return m >= 60 ? ' age-late' : (m >= 30 ? ' age-warn' : ''); }

    function renderKpis() {
        const k = $('floorKpis'); if (!k) return;
        const occ = openChecks.length;
        const pax = openChecks.reduce((s, c) => s + (Number(c.pax) || 0), 0);
        const kitchen = openChecks.filter(c => checkState(c).key === 'kitchen').length;
        const serving = openChecks.filter(c => checkState(c).key === 'served').length;
        const openTotal = round2(openChecks.reduce((s, c) => s + (Number(c.total) || 0), 0));
        const cards = [['Açık Adisyon', occ], ['Toplam Kişi', pax], ['Mutfakta', kitchen], ['Serviste', serving], ['Açık Tutar', money(openTotal)]];
        k.innerHTML = cards.map(([l, v]) => `<div class="rst-kpi"><span class="v">${esc(v)}</span><span class="l">${esc(l)}</span></div>`).join('');
    }
    function renderFloor() {
        renderKpis();
        const wrap = $('floorGrid'); if (!wrap) return;
        const dl = $('ckSecList'); if (dl) dl.innerHTML = sectionsOfChecks().map(s => `<option value="${esc(s)}">`).join('');
        if (!openChecks.length) {
            wrap.innerHTML = `<div class="rst-empty">Açık adisyon yok.<br>“+ Yeni Adisyon” ile masa no ve kişi sayısı girip başlayın.</div>`;
            return;
        }
        wrap.innerHTML = sectionsOfChecks().map(sec => {
            const cs = openChecks.filter(c => (c.section || 'Genel') === sec).sort(chkByOrder);
            return `<div class="rst-sec">
                <div class="rst-sec-h">${esc(sec)}</div>
                <div class="rst-tables">${cs.map(checkCardHtml).join('')}</div>
            </div>`;
        }).join('');
        wrap.querySelectorAll('[data-chk]').forEach(el => {
            el.onclick = () => { const c = openChecks.find(x => x.id === el.getAttribute('data-chk')); if (c) openPos(c); };
        });
    }
    // Kalemlerden türetilen adisyon durumu (renk + etiket). Öncelik: bekleyen > mutfak > servis.
    function checkState(c) {
        const items = c.items || [];
        if (!items.length) return { key: 'open', label: 'Açık' };
        const pending = items.some(i => !i.sent && !i.served);
        const kitchen = items.some(i => i.sent && !i.served);
        if (pending) return { key: 'open', label: 'Yeni' };
        if (kitchen) return { key: 'kitchen', label: 'Mutfakta' };
        return { key: 'served', label: 'Serviste' };
    }
    function checkCardHtml(c) {
        const st = checkState(c);
        const sub = [c.room ? 'Oda ' + c.room : '', c.name || ''].filter(Boolean).join(' · ');
        return `<button class="rst-tcard st-${st.key}${ageClass(c)}" data-chk="${esc(c.id)}">
            <span class="rst-tcard-rail"></span>
            <span class="rst-tcard-top">
                <span class="rst-tcard-no">${esc(c.tableName || '—')}</span>
                <span class="rst-tcard-amt">${esc(money(c.total || 0))}</span>
            </span>
            ${sub ? `<span class="rst-tcard-sub">${esc(sub)}</span>` : ''}
            <span class="rst-tcard-foot">
                <span class="rst-tcard-pill">${esc(st.label)}</span>
                <span class="rst-tcard-meta">${c.checkNo ? '#' + esc(c.checkNo) + ' · ' : ''}${esc(c.pax || 1)} kişi · ${esc(elapsed(c))}</span>
            </span>
        </button>`;
    }

    // Konaklayan (in-house) misafiri odasından bul
    function guestByRoom(room) {
        const r = String(room || '').trim().toLowerCase();
        if (!r) return null;
        return inhouse.find(g => String(g.room || '').trim().toLowerCase() === r) || null;
    }
    function fillRoomDatalist() {
        const dl = $('ckRoomList'); if (!dl) return;
        dl.innerHTML = inhouse.filter(g => g.room)
            .sort((a, b) => String(a.room).localeCompare(String(b.room), 'tr', { numeric: true }))
            .map(g => `<option value="${esc(g.room)}">${esc(g.name || '')}</option>`).join('');
    }
    function onRoomInput() {
        const g = guestByRoom($('ckRoom').value);
        $('ckGuestHint').textContent = g ? '✓ ' + (g.name || 'Misafir') + ' (otelde)' : '';
        $('ckGuestHint').className = 'rst-ck-guest' + (g ? ' ok' : '');
        if (g && !$('ckName').value.trim()) $('ckName').value = g.name || '';
    }

    // Adisyon aç / düzenle
    function openCheckModal(check) {
        editingCheckId = check ? check.id : null;
        $('checkModalTitle').textContent = check ? 'Adisyonu Düzenle' : 'Yeni Adisyon';
        $('ckSubmit').textContent = check ? 'Kaydet' : 'Adisyonu Aç';
        $('ckTable').value = check ? (check.tableName || '') : '';
        $('ckPax').value = check ? (check.pax || 1) : 2;
        $('ckRoom').value = check ? (check.room || '') : '';
        $('ckName').value = check ? (check.name || '') : '';
        $('ckSection').value = check ? (check.section || '') : '';
        fillRoomDatalist(); onRoomInput();
        $('checkModal').classList.add('open');
        setTimeout(() => { try { $('ckTable').focus(); } catch (e) {} }, 50);
    }
    function closeCheckModal() { $('checkModal').classList.remove('open'); editingCheckId = null; }
    function submitCheck(e) {
        e.preventDefault();
        const tableName = $('ckTable').value.trim();
        if (!tableName) { toast('Masa no zorunlu.', true); return; }
        const room = $('ckRoom').value.trim().slice(0, 20);
        const g = guestByRoom(room);
        const data = {
            tableName: tableName.slice(0, 20),
            pax: Math.max(1, parseInt($('ckPax').value, 10) || 1),
            room: room,
            name: ($('ckName').value.trim() || (g ? g.name : '') || '').slice(0, 40),
            section: ($('ckSection').value || 'Genel').trim().slice(0, 30) || 'Genel',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (editingCheckId) {
            if (currentCheck && currentCheck.id === editingCheckId) {
                currentCheck.tableName = data.tableName; currentCheck.pax = data.pax; currentCheck.room = data.room; currentCheck.name = data.name; currentCheck.section = data.section;
                setPosHeader(); flushSave();
            } else {
                db.collection(CHK_COL).doc(editingCheckId).update(data).catch(err => console.error(err));
            }
            closeCheckModal(); toast('Adisyon güncellendi.');
        } else {
            const TS = firebase.firestore.FieldValue.serverTimestamp();
            nextCheckNo().catch(() => null).then(no => {
                const payload = Object.assign({
                    tenantId: TENANT_ID, status: 'open', items: [], subtotal: 0, vat: 0, total: 0, openedBy: loggedUser, openedAt: TS
                }, data);
                if (no) payload.checkNo = no;
                db.collection(CHK_COL).add(payload).then(ref => {
                    closeCheckModal();
                    openPos({ id: ref.id, checkNo: no || null, tableName: data.tableName, pax: data.pax, room: data.room, name: data.name, section: data.section, status: 'open', items: [] });
                }).catch(err => { console.error(err); toast('Açılamadı.', true); });
            });
        }
    }
    // Sıralı adisyon no (tenant başına sayaç, transaction).
    const COUNTER_COL = 'restCounters';
    function nextCheckNo() {
        const ref = db.collection(COUNTER_COL).doc(TENANT_ID);
        return db.runTransaction(tx => tx.get(ref).then(doc => {
            const n = ((doc.exists && doc.data().checkNo) || 0) + 1;
            tx.set(ref, { tenantId: TENANT_ID, checkNo: n, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
            return n;
        }));
    }

    function listenChecks() {
        db.collection(CHK_COL).where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            openChecks = snap.docs.map(d => Object.assign({ id: d.id }, d.data()))
                .filter(c => c.status === 'open' || c.status === 'sent');
            renderFloor();
            if ($('view-kds') && $('view-kds').classList.contains('active')) renderKDS();
        }, err => console.error('checks', err));
    }

    // ── POS ────────────────────────────────────────────────────
    function setPosHeader() {
        $('posTable').textContent = 'Masa ' + (currentCheck.tableName || '');
        $('posMeta').textContent = (currentCheck.checkNo ? '#' + currentCheck.checkNo + ' · ' : '') + (currentCheck.room ? 'Oda ' + currentCheck.room + ' · ' : '') + (currentCheck.name ? currentCheck.name + ' · ' : '') + (currentCheck.pax || 1) + ' kişi';
        $('posPax').textContent = currentCheck.pax || 1;
    }
    function setPosPane(pane) {
        const ov = $('posOverlay'); if (!ov) return;
        ov.classList.toggle('show-check', pane === 'check');
        const sw = $('posSwitch');
        if (sw) sw.querySelectorAll('.rst-ps-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-pane') === pane));
        closePosFab();
    }
    // Mobil yüzen işlem menüsü (FAB) — mevcut buton davranışlarını yeniden kullanır.
    const FAB_MAP = { pay: 'posPay', send: 'posSend', serve: 'posServe', note: 'posNote', split: 'posSplit', merge: 'posMerge', transfer: 'posTransfer', void: 'posVoid' };
    function closePosFab() { const f = $('posFab'); if (f) f.classList.remove('open'); }
    function togglePosFab() { const f = $('posFab'); if (f) f.classList.toggle('open'); }
    function openPos(check) {
        currentCheck = JSON.parse(JSON.stringify(check));
        if (!currentCheck.items) currentCheck.items = [];
        selectedLineId = null;
        setPosPane('menu');
        setPosHeader();
        posCat = ''; posSearch = '';
        if ($('posSearch')) $('posSearch').value = '';
        renderPosMenu();
        renderPosCheck();
        $('posOverlay').classList.add('open');
    }
    function closePos() { closePosFab(); flushSave(); $('posOverlay').classList.remove('open'); currentCheck = null; }

    function renderPosMenu() {
        const cats = []; menu.filter(i => i.active !== false).sort(byOrder).forEach(i => { const c = i.category || 'Diğer'; if (!cats.includes(c)) cats.push(c); });
        if (!posCat || !cats.includes(posCat)) posCat = cats[0] || '';
        const searching = posSearch.trim().length > 0;
        $('posCats').innerHTML = (searching ? '' : cats.map(c => `<button class="rst-pcat ${c === posCat ? 'active' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join(''))
            || (searching ? '' : '<span class="rst-none">Menü boş — önce Menü sekmesinden ürün ekle.</span>');
        $('posCats').querySelectorAll('[data-c]').forEach(b => b.onclick = () => { posCat = b.getAttribute('data-c'); renderPosMenu(); });
        const q = posSearch.trim().toLowerCase();
        const items = searching
            ? menu.filter(i => i.active !== false && (i.name || '').toLowerCase().includes(q)).sort(byOrder).slice(0, 60)
            : menu.filter(i => i.active !== false && (i.category || 'Diğer') === posCat).sort(byOrder);
        $('posItems').innerHTML = items.length
            ? items.map(i => { const st = stockState(i); return `<button class="rst-pitem${st && st.cls === 'out' ? ' out' : ''}" data-mi="${esc(i.id)}">
                <span class="pi-n">${esc(i.name)}</span>
                <span class="pi-foot">
                    <span class="pi-p">${esc(money(i.price))}</span>
                    ${st && st.cls !== 'ok' ? `<span class="pi-stk ${st.cls}">${esc(st.label)}</span>` : ''}
                </span>
            </button>`; }).join('')
            : `<span class="rst-none">${searching ? 'Eşleşen ürün yok.' : ''}</span>`;
        $('posItems').querySelectorAll('[data-mi]').forEach(b => b.onclick = () => { const mi = menu.find(x => x.id === b.getAttribute('data-mi')); if (mi) addLine(mi); });
    }

    // Açık fiyatlı / hızlı ürün (menüde olmayan satış)
    function addQuickItem() {
        const name = (prompt('Ürün adı:') || '').trim();
        if (!name) return;
        const pv = prompt('Fiyat:', '');
        if (pv === null) return;
        const price = round2(parseFloat(String(pv).replace(',', '.')) || 0);
        if (price <= 0) { toast('Geçerli fiyat girin.', true); return; }
        const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        currentCheck.items.push({
            lineId: id,
            menuId: null, name: name.slice(0, 60), category: 'Açık Ürün',
            unitPrice: price, qty: 1, vatRate: null, station: 'kitchen', note: '', sent: false
        });
        selectedLineId = id;
        recalcSave();
    }

    function addLine(mi) {
        const ex = currentCheck.items.find(l => l.menuId === mi.id && !l.sent && !(l.note));
        if (ex) { ex.qty++; selectedLineId = ex.lineId; }
        else {
            const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
            currentCheck.items.push({
                lineId: id,
                menuId: mi.id, name: mi.name, category: mi.category || 'Diğer',
                unitPrice: Number(mi.price) || 0, qty: 1,
                vatRate: (mi.vatRate != null ? mi.vatRate : null), station: mi.station || 'kitchen', note: '', sent: false
            });
            selectedLineId = id;
        }
        if (mi.trackStock && (Number(mi.stock) || 0) <= 0) toast(mi.name + ' stokta görünmüyor (yine de eklendi).', true);
        recalcSave();
    }
    function changeQty(lineId, d) {
        const l = currentCheck.items.find(x => x.lineId === lineId); if (!l) return;
        l.qty += d;
        if (l.qty <= 0) { currentCheck.items = currentCheck.items.filter(x => x.lineId !== lineId); if (selectedLineId === lineId) selectedLineId = null; }
        recalcSave();
    }
    function removeLine(lineId) {
        currentCheck.items = currentCheck.items.filter(x => x.lineId !== lineId);
        if (selectedLineId === lineId) selectedLineId = null;
        recalcSave();
    }
    function ikramLine(lineId) {
        const l = currentCheck.items.find(x => x.lineId === lineId); if (!l) return;
        l.ikram = !l.ikram;
        recalcSave();
    }
    // Kaleme dokun → bağlamsal işlem çubuğu o kaleme yönelir
    function selectLine(lineId) {
        selectedLineId = (selectedLineId === lineId) ? null : lineId;
        renderPosCheck();
    }

    // ── Not penceresi (kalem / adisyon) — prompt yerine dokunmatik UI ──
    const NOTE_CHIPS = ['Az pişmiş', 'Orta', 'İyi pişmiş', 'Sossuz', 'Acılı', 'Acısız', 'Soğansız', 'Ekstra', 'Buzsuz', 'Servise dikkat'];
    let noteTarget = null;      // { kind:'line'|'check', lineId }
    function openNoteModal(kind, lineId) {
        if (!currentCheck) return;
        if (kind === 'line') { if (!lineId) return; const l = currentCheck.items.find(x => x.lineId === lineId); if (!l) return; }
        noteTarget = { kind: kind, lineId: lineId || null };
        const cur = kind === 'check'
            ? (currentCheck.note || '')
            : ((currentCheck.items.find(x => x.lineId === lineId) || {}).note || '');
        $('noteTitle').textContent = kind === 'check' ? 'Adisyon Notu' : 'Kalem Notu';
        const ta = $('noteText');
        ta.maxLength = kind === 'check' ? 160 : 80;
        ta.value = cur;
        $('noteChips').style.display = kind === 'line' ? 'flex' : 'none';
        $('noteChips').innerHTML = kind === 'line'
            ? NOTE_CHIPS.map(c => `<button type="button" class="rst-chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('')
            : '';
        $('noteChips').querySelectorAll('[data-chip]').forEach(b => b.onclick = () => {
            const v = ta.value.trim();
            ta.value = (v ? v + ', ' : '') + b.getAttribute('data-chip');
            ta.focus();
        });
        $('noteModal').classList.add('open');
        setTimeout(() => { try { ta.focus(); } catch (e) {} }, 50);
    }
    function closeNoteModal() { $('noteModal').classList.remove('open'); noteTarget = null; }
    function saveNote() {
        if (!noteTarget || !currentCheck) { closeNoteModal(); return; }
        const v = $('noteText').value.trim();
        if (noteTarget.kind === 'check') {
            currentCheck.note = v.slice(0, 160);
        } else {
            const l = currentCheck.items.find(x => x.lineId === noteTarget.lineId);
            if (l) l.note = v.slice(0, 80);
        }
        closeNoteModal();
        recalcSave();
    }
    // ── Adisyon böl ────────────────────────────────────────────
    function openSplit() {
        if (!currentCheck || currentCheck.items.length < 2) { toast('Bölmek için en az 2 kalem gerekir.', true); return; }
        $('splitList').innerHTML = currentCheck.items.map(l => `
            <label class="rst-split-row">
                <input type="checkbox" data-sl="${esc(l.lineId)}">
                <span class="sl-n">${esc(l.qty)}× ${esc(l.name)}${l.ikram ? ' · İkram' : ''}</span>
                <span class="sl-p">${esc(money(l.ikram ? 0 : round2((l.unitPrice || 0) * l.qty)))}</span>
            </label>`).join('');
        $('splitModal').classList.add('open');
    }
    function doSplit() {
        const ids = [...document.querySelectorAll('#splitList input[data-sl]:checked')].map(c => c.getAttribute('data-sl'));
        if (!ids.length) { toast('Kalem seçin.', true); return; }
        if (ids.length >= currentCheck.items.length) { toast('Tüm kalemler seçilemez.', true); return; }
        const moved = currentCheck.items.filter(l => ids.indexOf(l.lineId) !== -1).map(l => Object.assign({}, l, { sent: false }));
        const remaining = currentCheck.items.filter(l => ids.indexOf(l.lineId) === -1);
        const mt = computeTotals(moved);
        const TS = firebase.firestore.FieldValue.serverTimestamp();
        nextCheckNo().catch(() => null).then(no => {
            const payload = {
                tenantId: TENANT_ID, tableName: currentCheck.tableName || '', name: (currentCheck.name ? currentCheck.name + ' ' : '') + '(B)',
                room: '', section: currentCheck.section || 'Genel', status: 'open', pax: 1, note: '',
                items: moved, subtotal: mt.subtotal, vat: mt.vat, total: mt.total, openedBy: loggedUser, openedAt: TS
            };
            if (no) payload.checkNo = no;
            db.collection(CHK_COL).add(payload).catch(err => console.error(err));
            currentCheck.items = remaining; recalcSave(); flushSave();
            $('splitModal').classList.remove('open');
            toast('Adisyon bölündü' + (no ? ' → #' + no : '') + '.');
        });
    }
    // ── Adisyon birleştir ──────────────────────────────────────
    function openMerge() {
        if (!currentCheck) return;
        if (!currentCheck.id) { toast('Önce adisyona ürün ekleyin.', true); return; }
        const others = openChecks.filter(c => c.id !== currentCheck.id);
        if (!others.length) { toast('Birleştirilecek başka açık adisyon yok.', true); return; }
        $('mergeList').innerHTML = others.sort(chkByOrder).map(c => `
            <button type="button" class="rst-split-row rst-merge-row" data-mg="${esc(c.id)}">
                <span class="sl-n"><b>Masa ${esc(c.tableName || '—')}</b>${c.checkNo ? ' · #' + esc(c.checkNo) : ''} · ${esc(c.pax || 1)} kişi · ${esc((c.items || []).length)} kalem</span>
                <span class="sl-p">${esc(money(c.total || 0))}</span>
            </button>`).join('');
        $('mergeList').querySelectorAll('[data-mg]').forEach(b => b.onclick = () => doMerge(b.getAttribute('data-mg')));
        $('mergeModal').classList.add('open');
    }
    function doMerge(otherId) {
        const other = openChecks.find(c => c.id === otherId);
        if (!other || !currentCheck) return;
        if (!confirm('Masa ' + (other.tableName || '') + (other.checkNo ? ' (#' + other.checkNo + ')' : '') + ' adisyonu bu adisyona birleştirilsin mi? Diğer adisyon kapanır.')) return;
        const moved = (other.items || []).map(l => Object.assign({}, l));
        currentCheck.items = currentCheck.items.concat(moved);
        currentCheck.pax = (Number(currentCheck.pax) || 1) + (Number(other.pax) || 0);
        const notes = [currentCheck.note, other.note].filter(Boolean);
        if (notes.length) currentCheck.note = notes.join(' · ').slice(0, 160);
        db.collection(CHK_COL).doc(otherId).delete().catch(err => console.error(err));
        recalcSave(); flushSave();
        $('mergeModal').classList.remove('open');
        toast('Adisyonlar birleştirildi.');
    }

    // ── Masaya taşı ─────────────────────────────────────────────
    function openTransfer() {
        if (!currentCheck) return;
        $('transferTable').value = currentCheck.tableName || '';
        $('transferSection').value = currentCheck.section || '';
        const dl = $('ckSecList'); if (dl) dl.innerHTML = sectionsOfChecks().map(s => `<option value="${esc(s)}">`).join('');
        $('transferModal').classList.add('open');
        setTimeout(() => { try { $('transferTable').focus(); } catch (e) {} }, 50);
    }
    function doTransfer(e) {
        if (e) e.preventDefault();
        if (!currentCheck) return;
        const t = $('transferTable').value.trim();
        if (!t) { toast('Masa no zorunlu.', true); return; }
        currentCheck.tableName = t.slice(0, 20);
        currentCheck.section = ($('transferSection').value || 'Genel').trim().slice(0, 30) || 'Genel';
        setPosHeader();
        if (currentCheck.id || currentCheck.items.length) flushSave();
        $('transferModal').classList.remove('open');
        toast('Adisyon Masa ' + currentCheck.tableName + ' konumuna taşındı.');
    }

    function recalcSave() {
        const t = computeTotals(currentCheck.items);
        currentCheck.subtotal = t.subtotal; currentCheck.vat = t.vat; currentCheck.total = t.total;
        renderPosCheck(); scheduleSave();
    }
    // Hızlı arka arkaya değişikliklerde tek yazma (write churn / yarış azaltma).
    let saveTimer = null;
    function scheduleSave() { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = null; saveCheck(); }, 450); }
    function flushSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveCheck(); }
    function saveCheck() {
        if (!currentCheck) return;
        if (!currentCheck.items.length && !currentCheck.id) return; // boş adisyon yaratma
        const payload = {
            tenantId: TENANT_ID, tableName: currentCheck.tableName || '', name: currentCheck.name || '', room: currentCheck.room || '',
            section: currentCheck.section || 'Genel', status: currentCheck.status || 'open', pax: currentCheck.pax || 1, note: currentCheck.note || '',
            items: currentCheck.items, subtotal: currentCheck.subtotal || 0, vat: currentCheck.vat || 0, total: currentCheck.total || 0,
            sentAt: currentCheck.sentAt || null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (currentCheck.id) {
            db.collection(CHK_COL).doc(currentCheck.id).update(payload).catch(err => console.error(err));
        } else {
            payload.openedBy = loggedUser;
            payload.openedAt = firebase.firestore.FieldValue.serverTimestamp();
            db.collection(CHK_COL).add(payload).then(ref => { currentCheck.id = ref.id; }).catch(err => console.error(err));
        }
    }
    function sendKitchen() {
        if (!currentCheck || !currentCheck.items.length) { toast('Adisyon boş.', true); return; }
        const fresh = currentCheck.items.filter(l => !l.sent).length;
        currentCheck.items.forEach(l => l.sent = true);
        currentCheck.status = 'sent';
        if (fresh || !currentCheck.sentAt) currentCheck.sentAt = Date.now();
        const t = computeTotals(currentCheck.items);
        currentCheck.subtotal = t.subtotal; currentCheck.vat = t.vat; currentCheck.total = t.total;
        renderPosCheck(); flushSave();
        toast(fresh ? fresh + ' kalem mutfağa gönderildi.' : 'Mutfağa gönderildi.');
    }
    // Mutfağa göndermeden doğrudan servis (içecek, hazır ürün vb.) veya teslim edildi işareti.
    function serveLine(lineId) {
        const l = currentCheck.items.find(x => x.lineId === lineId); if (!l) return;
        if (l.served) { l.served = false; l.sent = false; l.ready = false; }
        else { l.served = true; l.sent = true; l.ready = true; }
        if (currentCheck.items.some(x => x.sent || x.served)) currentCheck.status = 'sent';
        recalcSave();
    }
    function serveAll() {
        if (!currentCheck || !currentCheck.items.length) { toast('Adisyon boş.', true); return; }
        const n = currentCheck.items.filter(l => !l.served).length;
        if (!n) { toast('Tüm kalemler zaten servis edildi.'); return; }
        currentCheck.items.forEach(l => { l.sent = true; l.served = true; l.ready = true; });
        currentCheck.status = 'sent';
        const t = computeTotals(currentCheck.items);
        currentCheck.subtotal = t.subtotal; currentCheck.vat = t.vat; currentCheck.total = t.total;
        renderPosCheck(); flushSave();
        toast(n + ' kalem servis edildi.');
    }
    // ── Mutfak Ekranı (KDS) ─────────────────────────────────────
    let kdsFilter = 'all';
    function kdsSentMs(c) { const d = tsToDate(c.sentAt) || tsToDate(c.openedAt); return d ? d.getTime() : 0; }
    function kdsMinAgo(c) { const ms = kdsSentMs(c); return ms ? Math.floor((Date.now() - ms) / 60000) : 0; }
    function kdsAgo(m) { if (m < 1) return 'az önce'; if (m < 60) return m + ' dk'; return Math.floor(m / 60) + ' sa ' + (m % 60) + ' dk'; }
    function kdsMatch(i) { return kdsFilter === 'all' || (i.station || 'kitchen') === kdsFilter; }
    function renderKDS() {
        const board = $('kdsBoard'); if (!board) return;
        const tickets = openChecks
            .map(c => ({ c: c, items: (c.items || []).filter(i => i.sent && !i.served && kdsMatch(i)) }))
            .filter(t => t.items.length)
            .sort((a, b) => kdsSentMs(a.c) - kdsSentMs(b.c));
        if (!tickets.length) { board.innerHTML = `<div class="rst-empty">Mutfakta bekleyen sipariş yok.</div>`; return; }
        board.innerHTML = tickets.map(t => {
            const c = t.c, m = kdsMinAgo(c), age = m >= 15 ? ' late' : (m >= 8 ? ' warn' : '');
            const allReady = t.items.every(i => i.ready);
            return `<div class="rst-kds-ticket${age}${allReady ? ' done' : ''}">
                <div class="rst-kds-head">
                    <b>Masa ${esc(c.tableName || '—')}</b>
                    <span class="rst-kds-time">${esc(kdsAgo(m))}</span>
                </div>
                <div class="rst-kds-sub">${c.checkNo ? '#' + esc(c.checkNo) + ' · ' : ''}${esc(c.pax || 1)} kişi${c.name ? ' · ' + esc(c.name) : ''}</div>
                ${c.note ? `<div class="rst-kds-note">${esc(c.note)}</div>` : ''}
                <div class="rst-kds-items">
                    ${t.items.map(i => `<button type="button" class="rst-kds-item${i.ready ? ' ready' : ''}" data-kc="${esc(c.id)}" data-kl="${esc(i.lineId)}">
                        <span class="ki-q">${esc(i.qty)}×</span>
                        <span class="ki-n">${esc(i.name)}${i.station === 'bar' ? ' <span class="ki-tag bar">BAR</span>' : ''}${i.ikram ? ' <span class="ki-tag ik">İKRAM</span>' : ''}${i.note ? `<span class="ki-note">“${esc(i.note)}”</span>` : ''}</span>
                        <span class="ki-chk">${i.ready ? '✓' : ''}</span>
                    </button>`).join('')}
                </div>
                <button type="button" class="rst-btn primary rst-kds-serve" data-ks="${esc(c.id)}">Servis Et</button>
            </div>`;
        }).join('');
        board.querySelectorAll('[data-kc]').forEach(b => b.onclick = () => kdsToggleReady(b.getAttribute('data-kc'), b.getAttribute('data-kl')));
        board.querySelectorAll('[data-ks]').forEach(b => b.onclick = () => kdsServe(b.getAttribute('data-ks')));
    }
    function kdsUpdate(checkId, mutate) {
        const ref = db.collection(CHK_COL).doc(checkId);
        return db.runTransaction(tx => tx.get(ref).then(doc => {
            if (!doc.exists) return;
            const items = (doc.data().items || []).map(it => Object.assign({}, it));
            mutate(items);
            tx.update(ref, { items: items, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        }));
    }
    function kdsToggleReady(checkId, lineId) {
        kdsUpdate(checkId, items => { const it = items.find(x => x.lineId === lineId); if (it) it.ready = !it.ready; })
            .catch(err => { console.error(err); toast('Güncellenemedi.', true); });
    }
    function kdsServe(checkId) {
        kdsUpdate(checkId, items => items.forEach(it => { if (it.sent && !it.served && kdsMatch(it)) it.served = true; }))
            .then(() => toast('Sipariş servis edildi.')).catch(err => { console.error(err); toast('İşlem başarısız.', true); });
    }

    function voidCheck() {
        if (!currentCheck) return;
        if (!currentCheck.id) { $('posOverlay').classList.remove('open'); currentCheck = null; return; }
        if (!confirm('Adisyon iptal edilsin mi? (Masa boşalır)')) return;
        db.collection(CHK_COL).doc(currentCheck.id).update({ status: 'void', updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
            .then(() => { toast('Adisyon iptal edildi.'); $('posOverlay').classList.remove('open'); currentCheck = null; })
            .catch(err => { console.error(err); toast('İşlem başarısız.', true); });
    }
    function setPax(d) {
        if (!currentCheck) return;
        currentCheck.pax = Math.max(1, (currentCheck.pax || 1) + d);
        setPosHeader();
        if (currentCheck.id || currentCheck.items.length) scheduleSave();
    }

    function renderLineBar() {
        const bar = $('posLineBar'); if (!bar) return;
        const l = selectedLineId ? currentCheck.items.find(x => x.lineId === selectedLineId) : null;
        if (!l) { bar.style.display = 'none'; return; }
        bar.style.display = 'block';
        $('posSelName').textContent = l.name + (l.ikram ? ' · İkram' : '');
        $('posSelQty').textContent = l.qty;
        $('posSelIkram').classList.toggle('on', !!l.ikram);
        $('posSelIkram').textContent = l.ikram ? 'İkramı geri al' : 'İkram';
        const sv = $('posSelServe');
        if (sv) { sv.classList.toggle('on', !!l.served); sv.textContent = l.served ? 'Servisi geri al' : 'Servis'; }
    }

    function renderPosCheck() {
        const lines = $('posLines');
        if (selectedLineId && !currentCheck.items.some(x => x.lineId === selectedLineId)) selectedLineId = null;
        if (!currentCheck.items.length) {
            lines.innerHTML = `<div class="rst-check-empty">Soldan ürün ekleyin.</div>`;
        } else {
            lines.innerHTML = currentCheck.items.map(l => {
                const badge = l.served ? '<span class="rst-line-tag srv">SERVİS</span>'
                    : (l.sent ? '<span class="rst-line-tag knt">MUTFAK</span>' : '');
                return `<button type="button" class="rst-line ${l.sent ? 'sent' : ''}${l.served ? ' served' : ''}${l.ikram ? ' ikram' : ''}${l.lineId === selectedLineId ? ' sel' : ''}" data-line="${esc(l.lineId)}">
                <span class="rst-line-q">${esc(l.qty)}×</span>
                <span class="rst-line-main">
                    <span class="rst-line-n">${esc(l.name)}${badge}${l.ikram ? ' <span class="rst-line-ik">İKRAM</span>' : ''}</span>
                    ${l.note ? `<span class="rst-line-note">“${esc(l.note)}”</span>` : ''}
                </span>
                <span class="rst-line-tot">${esc(money(l.ikram ? 0 : round2((l.unitPrice || 0) * l.qty)))}</span>
            </button>`;
            }).join('');
            lines.querySelectorAll('[data-line]').forEach(b => b.onclick = () => selectLine(b.getAttribute('data-line')));
        }
        renderLineBar();
        const noteEl = $('posNoteLine');
        if (noteEl) { noteEl.style.display = currentCheck.note ? 'block' : 'none'; noteEl.textContent = currentCheck.note ? 'Not: ' + currentCheck.note : ''; }
        const t = computeTotals(currentCheck.items);
        const vatLabel = (cfg.vatMode === 'excluded') ? 'KDV (hariç)' : 'KDV (dahil)';
        $('posTotals').innerHTML = `
            <div class="rst-tot-row"><span>Ara Toplam</span><b>${esc(money(t.subtotal))}</b></div>
            <div class="rst-tot-row"><span>${vatLabel}</span><b>${esc(money(t.vat))}</b></div>
            <div class="rst-tot-row big"><span>Toplam</span><b>${esc(money(t.total))}</b></div>`;
        const sc = $('posSwitchCount'); if (sc) sc.textContent = currentCheck.items.length;
        const stl = $('posSwitchTotal'); if (stl) stl.textContent = money(t.total);
    }

    // ════════════════════════════════════════════════════════════
    //  ÖDEME + FOLIO (oda hesabı) + FİŞ
    // ════════════════════════════════════════════════════════════
    const FOLIO_COL = 'folioCharges';
    let inhouse = [];          // oteldeki misafirler (oda hesabı için)
    let folio = [];            // açık folio kayıtları
    let pay = null;            // ödeme oturumu: { discount, payments[] }

    const PM_LABEL = { cash: 'Nakit', card: 'Kart', room: 'Oda Hesabı' };

    function discountAmount(total) {
        if (!pay || !pay.discount) return 0;
        const d = pay.discount;
        if (d.type === 'percent') return round2(total * (Number(d.value) || 0) / 100);
        return round2(Math.min(Number(d.value) || 0, total));
    }
    function payable() {
        const t = computeTotals(currentCheck.items);
        return { gross: t, payable: round2(t.total - discountAmount(t.total)) };
    }
    function paidSum() { return round2((pay.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0)); }

    let payEntry = '';   // tuş takımıyla girilen tutar (string)

    function openPay() {
        if (!currentCheck || !currentCheck.items.length) { toast('Adisyon boş.', true); return; }
        pay = { discount: currentCheck.discount || null, payments: [] };
        payEntry = '';
        $('payTable').textContent = 'Masa ' + (currentCheck.tableName || '');
        renderPay();
        $('payModal').classList.add('open');
    }
    function closePay() { $('payModal').classList.remove('open'); pay = null; payEntry = ''; }

    function remaining() { const p = payable(); return round2(p.payable - paidSum()); }
    function entryVal() { return round2(parseFloat(String(payEntry || '0').replace(',', '.')) || 0); }

    function renderPay() {
        const p = payable();
        const dA = discountAmount(p.gross.total);
        $('payDue').textContent = money(p.payable);
        $('paySum').innerHTML = `
            <div class="rst-tot-row"><span>Ara Toplam</span><b>${esc(money(p.gross.subtotal))}</b></div>
            <div class="rst-tot-row"><span>${cfg.vatMode === 'excluded' ? 'KDV (hariç)' : 'KDV (dahil)'}</span><b>${esc(money(p.gross.vat))}</b></div>
            ${dA ? `<div class="rst-tot-row"><span>İndirim/İkram</span><b>−${esc(money(dA))}</b></div>` : ''}`;
        $('payEntry').textContent = money(entryVal());
        $('payDiscLabel').textContent = pay.discount
            ? 'İndirim: ' + (pay.discount.type === 'percent' ? '%' + pay.discount.value : money(pay.discount.value)) + (pay.discount.reason ? ' · ' + pay.discount.reason : '')
            : '';
        const list = $('payList');
        list.innerHTML = (pay.payments || []).map((pm, i) => `<div class="rst-payrow">
            <span class="rst-payrow-m">${esc(PM_LABEL[pm.method] || pm.method)}${pm.room ? ' · Oda ' + esc(pm.room) : ''}</span>
            <span class="rst-payrow-a">${esc(money(pm.amount))}</span>
            <button data-rmpay="${i}" title="Kaldır">✕</button>
        </div>`).join('');
        list.querySelectorAll('[data-rmpay]').forEach(b => b.onclick = () => { pay.payments.splice(+b.getAttribute('data-rmpay'), 1); renderPay(); });
        const remain = remaining();
        $('payRemain').innerHTML = remain > 0.005
            ? `<span>Kalan</span><b class="due">${esc(money(remain))}</b>`
            : `<span>${paidSum() > p.payable + 0.005 ? 'Para Üstü' : 'Tamam'}</span><b class="ok">${esc(money(Math.abs(remain)))}</b>`;
        // Kapanış: ödenecek 0 (tam ikram) veya kalan tamamen ödendiyse.
        $('paySettle').disabled = !(p.payable <= 0.005 || (paidSum() > 0 && remain <= 0.005));
    }

    function keypad(k) {
        if (k === 'clear') payEntry = '';
        else if (k === 'back') payEntry = payEntry.slice(0, -1);
        else if (k === 'full') payEntry = String(Math.max(0, remaining()));
        else if (k === ',') { if (payEntry.indexOf(',') === -1) payEntry = (payEntry || '0') + ','; }
        else {
            const dec = payEntry.split(',')[1];
            if (dec && dec.length >= 2) return;           // en fazla 2 ondalık
            if (!(payEntry === '' && k === '0')) payEntry = (payEntry + k).slice(0, 12);
        }
        $('payEntry').textContent = money(entryVal());
    }
    function addPayment(method) {
        const remain = remaining();
        const amt = entryVal() > 0 ? entryVal() : (remain > 0 ? remain : 0);
        if (amt <= 0) { toast('Tutar girin.', true); return; }
        if (method === 'room') {
            // Adisyon bir odaya bağlıysa doğrudan o odaya yaz; değilse oda seç.
            if (currentCheck && currentCheck.room) {
                pay.payments.push({ method: 'room', amount: amt, room: currentCheck.room, guestName: currentCheck.name || '' });
                payEntry = ''; renderPay();
            } else { pickRoom(amt); }
            return;
        }
        pay.payments.push({ method, amount: amt });
        payEntry = '';
        renderPay();
    }
    function pickRoom(amt) {
        if (!inhouse.length) { toast('Otelde misafir görünmüyor.', true); return; }
        const list = $('roomList');
        list.innerHTML = inhouse.map(g => `<button class="rst-room" data-g="${esc(g.id)}">
            <b>${esc(g.name || '—')}</b><span>Oda ${esc(g.room || '—')}</span></button>`).join('');
        list.querySelectorAll('[data-g]').forEach(b => b.onclick = () => {
            const g = inhouse.find(x => x.id === b.getAttribute('data-g'));
            $('roomModal').classList.remove('open');
            pay.payments.push({ method: 'room', amount: amt, room: g.room || '', guestName: g.name || '', guestId: g.id });
            payEntry = '';
            renderPay();
        });
        $('roomModal').classList.add('open');
    }
    function setDiscount() {
        const raw = prompt('İndirim/İkram — yüzde için "%" ile (örn %10), tutar için sayı (örn 50). Kaldırmak için 0:', pay.discount ? (pay.discount.type === 'percent' ? '%' + pay.discount.value : pay.discount.value) : '');
        if (raw === null) return;
        const s = String(raw).trim();
        if (!s || s === '0') { pay.discount = null; renderPay(); return; }
        let type = 'amount', value;
        if (s.indexOf('%') !== -1) { type = 'percent'; value = parseFloat(s.replace('%', '').replace(',', '.')) || 0; }
        else value = parseFloat(s.replace(',', '.')) || 0;
        if (value <= 0) { pay.discount = null; renderPay(); return; }
        const reason = prompt('Sebep (opsiyonel):', pay.discount ? (pay.discount.reason || '') : '') || '';
        pay.discount = { type, value, reason: reason.slice(0, 60) };
        renderPay();
    }

    function settle() {
        const p = payable();
        const dA = discountAmount(p.gross.total);
        const TS = firebase.firestore.FieldValue.serverTimestamp();
        const checkId = currentCheck.id;
        const payload = {
            status: 'paid',
            discount: pay.discount ? { type: pay.discount.type, value: pay.discount.value, reason: pay.discount.reason || '', amount: dA } : null,
            payments: pay.payments.map(pm => ({ method: pm.method, amount: pm.amount, room: pm.room || '', guestName: pm.guestName || '', at: Date.now(), by: loggedUser })),
            subtotal: p.gross.subtotal, vat: p.gross.vat, total: p.gross.total, payable: p.payable,
            closedBy: loggedUser, closedAt: TS, updatedAt: TS
        };
        const finish = () => {
            // Oda hesabı ödemeleri → folio kaydı
            const roomPays = pay.payments.filter(pm => pm.method === 'room' && pm.amount > 0);
            const batch = db.batch();
            roomPays.forEach(pm => {
                const ref = db.collection(FOLIO_COL).doc();
                batch.set(ref, {
                    tenantId: TENANT_ID, room: pm.room || '', guestName: pm.guestName || '',
                    source: 'restaurant', checkId: (currentCheck && currentCheck.id) || checkId || '', tableName: currentCheck.tableName || '',
                    amount: pm.amount, status: 'open', createdAt: TS, by: loggedUser
                });
            });
            if (roomPays.length) batch.commit().catch(err => console.error(err));
            decrementStock(currentCheck.items);
            toast('Adisyon kapatıldı.');
            closePay();
            $('posOverlay').classList.remove('open');
            currentCheck = null;
        };
        if (!checkId) { // adisyon henüz yazılmadıysa (teorik) — oluştur
            db.collection(CHK_COL).add(Object.assign({
                tenantId: TENANT_ID, tableName: currentCheck.tableName || '', name: currentCheck.name || '', room: currentCheck.room || '',
                section: currentCheck.section || 'Genel', pax: currentCheck.pax || 1, items: currentCheck.items, openedBy: loggedUser, openedAt: TS
            }, payload)).then(ref => { currentCheck.id = ref.id; finish(); }).catch(err => { console.error(err); toast('Kapatılamadı.', true); });
        } else {
            db.collection(CHK_COL).doc(checkId).update(payload).then(finish).catch(err => { console.error(err); toast('Kapatılamadı.', true); });
        }
    }

    // ── Fiş (80mm termal) ──────────────────────────────────────
    function fmtTime(ts) {
        const d = tsToDate(ts); if (!d) return '';
        const p = n => n < 10 ? '0' + n : '' + n;
        return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function receiptRows(items) {
        return (items || []).map(l => {
            const lt = money(l.ikram ? 0 : round2((l.unitPrice || 0) * l.qty));
            return `<tr><td>${esc(l.qty)}×</td><td>${esc(l.name)}${l.ikram ? ' (İkram)' : ''}</td><td class="r">${esc(lt)}</td></tr>`
                + (l.note ? `<tr><td></td><td colspan="2" class="note">» ${esc(l.note)}</td></tr>` : '');
        }).join('');
    }
    // Tek fiş çıktısı (canlı ödeme + arşiv yeniden yazdırma için ortak).
    function printReceiptDoc(c) {
        const w = window.open('', '_blank', 'width=380,height=640');
        if (!w) { toast('Açılır pencere engellendi.', true); return; }
        const pays = (c.payments || []).map(pm => `<tr><td colspan="2">${esc(PM_LABEL[pm.method] || pm.method)}${pm.room ? ' (Oda ' + esc(pm.room) + ')' : ''}</td><td class="r">${esc(money(pm.amount))}</td></tr>`).join('');
        w.document.write(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Fiş</title>
<style>
 @page{size:80mm auto;margin:0}
 *{box-sizing:border-box}
 body{width:80mm;margin:0;padding:8px 10px;font-family:'Courier New',monospace;font-size:12px;color:#000}
 .r{text-align:right}
 h1{font-size:15px;margin:0 0 2px;text-align:center}
 .sub{text-align:center;font-size:11px;margin-bottom:3px}
 hr{border:none;border-top:1px dashed #000;margin:6px 0}
 table{width:100%;border-collapse:collapse}
 td{padding:1px 0;vertical-align:top;font-size:12px}
 .note{font-size:10px;color:#333}
 .tot .big{font-size:15px;font-weight:bold}
 .ft{text-align:center;font-size:11px;margin-top:8px}
</style></head><body>
<h1>${esc(cfg.receiptHeader || cfg.name || 'Restoran')}</h1>
<div class="sub">${c.checkNo ? 'Adisyon #' + esc(c.checkNo) + ' · ' : ''}Masa ${esc(c.tableName || '')}${c.room ? ' · Oda ' + esc(c.room) : ''} · ${esc(c.pax || 1)} kişi</div>
<div class="sub">${esc(c.by || loggedUser)}${c.when ? ' · ' + esc(c.when) : ''}</div>
<hr>
<table>${receiptRows(c.items)}</table>
${c.note ? '<div class="note">Not: ' + esc(c.note) + '</div>' : ''}
<hr>
<table class="tot">
 <tr><td colspan="2">Ara Toplam</td><td class="r">${esc(money(c.subtotal || 0))}</td></tr>
 <tr><td colspan="2">KDV</td><td class="r">${esc(money(c.vat || 0))}</td></tr>
 ${c.discountAmount ? `<tr><td colspan="2">İndirim</td><td class="r">-${esc(money(c.discountAmount))}</td></tr>` : ''}
 <tr class="big"><td colspan="2">TOPLAM</td><td class="r">${esc(money(c.payable || 0))}</td></tr>
</table>
${pays ? '<hr><table>' + pays + '</table>' : ''}
<div class="ft">${esc(cfg.receiptFooter || 'Bizi tercih ettiğiniz için teşekkürler.')}</div>
<scr` + `ipt>window.onload=function(){setTimeout(function(){window.print();},250);}</scr` + `ipt>
</body></html>`);
        w.document.close();
    }
    function printReceipt() {
        const p = payable();
        printReceiptDoc({
            checkNo: currentCheck.checkNo, tableName: currentCheck.tableName, room: currentCheck.room, pax: currentCheck.pax,
            by: loggedUser, items: currentCheck.items, note: currentCheck.note, subtotal: p.gross.subtotal, vat: p.gross.vat, payable: p.payable,
            discountAmount: discountAmount(p.gross.total), payments: (pay && pay.payments) || []
        });
    }
    function printStored(check) {
        printReceiptDoc({
            checkNo: check.checkNo, tableName: check.tableName, room: check.room, pax: check.pax, note: check.note,
            by: check.closedBy || check.openedBy, when: fmtTime(check.closedAt),
            items: check.items, subtotal: check.subtotal || 0, vat: check.vat || 0,
            payable: (check.payable != null ? check.payable : check.total) || 0,
            discountAmount: (check.discount && check.discount.amount) || 0, payments: check.payments || []
        });
    }

    // ── Folio (Oda Hesapları) ──────────────────────────────────
    function listenInhouse() {
        db.collection('guestDirectory').where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            inhouse = snap.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(g => g.status === 'in_house');
        }, err => console.error('inhouse', err));
    }
    function listenFolio() {
        db.collection(FOLIO_COL).where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            folio = snap.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(f => f.status === 'open');
            renderFolio();
        }, err => console.error('folio', err));
    }
    function renderFolio() {
        const wrap = $('folioList'); if (!wrap) return;
        if (!folio.length) { wrap.innerHTML = `<div class="rst-empty">Açık oda hesabı yok.</div>`; return; }
        const byRoom = {};
        folio.forEach(f => { const k = (f.room || '—') + '|' + (f.guestName || ''); (byRoom[k] = byRoom[k] || []).push(f); });
        wrap.innerHTML = Object.keys(byRoom).sort().map(k => {
            const arr = byRoom[k]; const room = arr[0].room || '—'; const guest = arr[0].guestName || '';
            const tot = round2(arr.reduce((s, f) => s + (Number(f.amount) || 0), 0));
            const items = arr.map(f => `<div class="rst-folio-row"><span>${esc(f.tableName ? 'Masa ' + f.tableName : 'Restoran')}</span><b>${esc(money(f.amount))}</b></div>`).join('');
            return `<div class="rst-folio-card">
                <div class="rst-folio-head">
                    <div><div class="rst-folio-room">Oda ${esc(room)}</div><div class="rst-folio-guest">${esc(guest)}</div></div>
                    <div class="rst-folio-tot">${esc(money(tot))}</div>
                </div>
                <div class="rst-folio-rows">${items}</div>
                <button class="rst-btn primary rst-folio-settle" data-settle="${esc(k)}">Tahsil Et &amp; Kapat</button>
            </div>`;
        }).join('');
        wrap.querySelectorAll('[data-settle]').forEach(b => b.onclick = () => settleFolio(b.getAttribute('data-settle')));
    }
    function settleFolio(key) {
        const arr = folio.filter(f => ((f.room || '—') + '|' + (f.guestName || '')) === key);
        if (!arr.length) return;
        const tot = round2(arr.reduce((s, f) => s + (Number(f.amount) || 0), 0));
        if (!confirm('Oda ' + (arr[0].room || '—') + ' hesabı (' + money(tot) + ') tahsil edilip kapatılsın mı?')) return;
        const TS = firebase.firestore.FieldValue.serverTimestamp();
        const batch = db.batch();
        arr.forEach(f => batch.update(db.collection(FOLIO_COL).doc(f.id), { status: 'settled', settledAt: TS, settledBy: loggedUser }));
        batch.commit().then(() => toast('Oda hesabı kapatıldı.')).catch(err => { console.error(err); toast('İşlem başarısız.', true); });
    }

    // ── Arşiv (kapanmış adisyonlar) ────────────────────────────
    let arcChecks = [];
    function todayYmd() { const d = new Date(); const p = n => n < 10 ? '0' + n : '' + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
    function payLabels(c) { return [...new Set((c.payments || []).map(p => PM_LABEL[p.method] || p.method))].join(', ') || '—'; }
    function checkTotal(c) { return Number(c.payable != null ? c.payable : c.total) || 0; }
    function loadArchive() {
        const day = $('arcDate').value || todayYmd();
        const p = day.split('-');
        const s = new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0);
        const e = new Date(+p[0], +p[1] - 1, +p[2], 23, 59, 59, 999);
        $('arcList').innerHTML = `<div class="rst-empty">Yükleniyor…</div>`;
        const handle = docs => {
            arcChecks = docs.map(d => Object.assign({ id: d.id }, d.data()))
                .filter(c => c.status === 'paid')
                .sort((a, b) => (b.checkNo || 0) - (a.checkNo || 0));
            renderArc();
        };
        db.collection(CHK_COL).where('tenantId', '==', TENANT_ID).where('closedAt', '>=', s).where('closedAt', '<=', e).get()
            .then(snap => handle(snap.docs))
            .catch(() => {
                db.collection(CHK_COL).where('tenantId', '==', TENANT_ID).get()
                    .then(snap => handle(snap.docs.filter(d => { const dt = tsToDate((d.data() || {}).closedAt); return dt && dt >= s && dt <= e; })))
                    .catch(err => { console.error(err); $('arcList').innerHTML = `<div class="rst-empty">Yüklenemedi.</div>`; });
            });
    }
    function renderArc() {
        const rev = round2(arcChecks.reduce((s, c) => s + checkTotal(c), 0));
        const pax = arcChecks.reduce((s, c) => s + (Number(c.pax) || 0), 0);
        $('arcStats').innerHTML = [['Adisyon', arcChecks.length], ['Kişi', pax], ['Ciro', money(rev)], ['Ort. Adisyon', money(arcChecks.length ? rev / arcChecks.length : 0)]]
            .map(([l, v]) => `<div class="rst-kpi"><span class="v">${esc(v)}</span><span class="l">${esc(l)}</span></div>`).join('');
        const wrap = $('arcList');
        if (!arcChecks.length) { wrap.innerHTML = `<div class="rst-empty">Bu gün için kapanmış adisyon yok.</div>`; return; }
        wrap.innerHTML = `<div class="rst-arc-tbl">
            <div class="rst-arc-h"><span>No</span><span>Masa</span><span>Oda / İsim</span><span class="c">Kişi</span><span>Ödeme</span><span class="c">Saat</span><span class="r">Tutar</span></div>
            ${arcChecks.map(arcRow).join('')}</div>`;
        wrap.querySelectorAll('[data-arc]').forEach(el => el.onclick = () => openArc(el.getAttribute('data-arc')));
    }
    function arcRow(c) {
        const t = tsToDate(c.closedAt); const p2 = n => n < 10 ? '0' + n : '' + n;
        const hm = t ? p2(t.getHours()) + ':' + p2(t.getMinutes()) : '—';
        return `<button class="rst-arc-r" data-arc="${esc(c.id)}">
            <span class="no">#${esc(c.checkNo || '—')}</span>
            <span>${esc(c.tableName || '—')}</span>
            <span>${esc(c.room ? 'Oda ' + c.room : (c.name || '—'))}</span>
            <span class="c">${esc(c.pax || 1)}</span>
            <span>${esc(payLabels(c))}</span>
            <span class="c">${esc(hm)}</span>
            <span class="r">${esc(money(checkTotal(c)))}</span>
        </button>`;
    }
    function openArc(id) {
        const c = arcChecks.find(x => x.id === id); if (!c) return;
        $('arcModalTitle').textContent = 'Adisyon #' + (c.checkNo || '—') + ' · Masa ' + (c.tableName || '');
        const items = (c.items || []).map(l => `<div class="rst-folio-row"><span>${esc(l.qty)}× ${esc(l.name)}${l.note ? ' · ' + esc(l.note) : ''}</span><b>${esc(money(round2((l.unitPrice || 0) * l.qty)))}</b></div>`).join('');
        const pays = (c.payments || []).map(pm => `<div class="rst-folio-row"><span>${esc(PM_LABEL[pm.method] || pm.method)}${pm.room ? ' · Oda ' + esc(pm.room) : ''}</span><b>${esc(money(pm.amount))}</b></div>`).join('');
        const dA = (c.discount && c.discount.amount) || 0;
        $('arcDetail').innerHTML = `
            <div class="rst-arc-meta">${esc(c.room ? 'Oda ' + c.room + ' · ' : '')}${esc(c.name || '')}${c.name ? ' · ' : ''}${esc(c.pax || 1)} kişi · ${esc(c.closedBy || c.openedBy || '')} · ${esc(fmtTime(c.closedAt))}</div>
            <div class="rst-arc-sec">${items || '<div class="rst-folio-row"><span>—</span></div>'}</div>
            <div class="rst-arc-tot">
                <div class="rst-tot-row"><span>Ara Toplam</span><b>${esc(money(c.subtotal || 0))}</b></div>
                <div class="rst-tot-row"><span>KDV</span><b>${esc(money(c.vat || 0))}</b></div>
                ${dA ? `<div class="rst-tot-row"><span>İndirim</span><b>-${esc(money(dA))}</b></div>` : ''}
                <div class="rst-tot-row big"><span>Toplam</span><b>${esc(money(checkTotal(c)))}</b></div>
            </div>
            ${pays ? `<div class="rst-arc-sec">${pays}</div>` : ''}`;
        $('arcPrint').onclick = () => printStored(c);
        $('arcModal').classList.add('open');
    }

    function wireFloorPos() {
        $('newCheckBtn').onclick = () => openCheckModal(null);
        $('checkModalClose').onclick = closeCheckModal;
        $('checkForm').onsubmit = submitCheck;
        $('ckRoom').oninput = onRoomInput;
        $('arcDate').onchange = loadArchive;
        $('arcClose').onclick = () => $('arcModal').classList.remove('open');
        $('arcModal').addEventListener('click', e => { if (e.target === $('arcModal')) $('arcModal').classList.remove('open'); });
        $('checkModal').addEventListener('click', e => { if (e.target === $('checkModal')) closeCheckModal(); });
        $('posBack').onclick = closePos;
        const sw = $('posSwitch');
        if (sw) sw.addEventListener('click', e => { const t = e.target.closest('.rst-ps-tab'); if (t) setPosPane(t.getAttribute('data-pane')); });
        if ($('posFabMain')) $('posFabMain').onclick = togglePosFab;
        if ($('posFabScrim')) $('posFabScrim').onclick = closePosFab;
        document.querySelectorAll('#posFab [data-fab]').forEach(b => b.onclick = () => {
            const id = FAB_MAP[b.getAttribute('data-fab')]; closePosFab(); if (id && $(id)) $(id).click();
        });
        $('posVoid').onclick = voidCheck;
        $('posSend').onclick = sendKitchen;
        $('posServe').onclick = serveAll;
        $('posPay').onclick = () => { flushSave(); openPay(); };
        $('posNote').onclick = () => openNoteModal('check');
        $('posSplit').onclick = openSplit;
        $('posMerge').onclick = openMerge;
        $('posTransfer').onclick = openTransfer;
        $('mergeClose').onclick = () => $('mergeModal').classList.remove('open');
        $('mergeModal').addEventListener('click', e => { if (e.target === $('mergeModal')) $('mergeModal').classList.remove('open'); });
        $('transferClose').onclick = () => $('transferModal').classList.remove('open');
        $('transferForm').onsubmit = doTransfer;
        $('transferModal').addEventListener('click', e => { if (e.target === $('transferModal')) $('transferModal').classList.remove('open'); });
        // Bağlamsal kalem işlem çubuğu
        $('posSelMinus').onclick = () => { if (selectedLineId) changeQty(selectedLineId, -1); };
        $('posSelPlus').onclick = () => { if (selectedLineId) changeQty(selectedLineId, 1); };
        $('posSelServe').onclick = () => { if (selectedLineId) serveLine(selectedLineId); };
        $('posSelIkram').onclick = () => { if (selectedLineId) ikramLine(selectedLineId); };
        $('posSelNote').onclick = () => { if (selectedLineId) openNoteModal('line', selectedLineId); };
        $('posSelDel').onclick = () => { if (selectedLineId) removeLine(selectedLineId); };
        // Not penceresi
        $('noteClose').onclick = closeNoteModal;
        $('noteCancel').onclick = closeNoteModal;
        $('noteSave').onclick = saveNote;
        $('noteModal').addEventListener('click', e => { if (e.target === $('noteModal')) closeNoteModal(); });
        $('splitClose').onclick = () => $('splitModal').classList.remove('open');
        $('splitConfirm').onclick = doSplit;
        $('splitModal').addEventListener('click', e => { if (e.target === $('splitModal')) $('splitModal').classList.remove('open'); });
        $('posPaxMinus').onclick = () => setPax(-1);
        $('posPaxPlus').onclick = () => setPax(1);
        $('posMove').onclick = () => { if (currentCheck) openCheckModal(currentCheck); };
        $('posQuick').onclick = addQuickItem;
        $('posSearch').oninput = e => { posSearch = e.target.value; renderPosMenu(); };
        // Payment modal
        $('payClose').onclick = closePay;
        $('payModal').addEventListener('click', e => { if (e.target === $('payModal')) closePay(); });
        $('payDiscBtn').onclick = setDiscount;
        $('payReceipt').onclick = printReceipt;
        $('paySettle').onclick = settle;
        document.querySelectorAll('#payModal [data-pm]').forEach(b => b.onclick = () => addPayment(b.getAttribute('data-pm')));
        document.querySelectorAll('#payKeys [data-k]').forEach(b => b.onclick = () => keypad(b.getAttribute('data-k')));
        $('roomClose').onclick = () => $('roomModal').classList.remove('open');
        $('roomModal').addEventListener('click', e => { if (e.target === $('roomModal')) $('roomModal').classList.remove('open'); });
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
        $('miTrackStock').onchange = () => { $('miStockRow').style.display = $('miTrackStock').checked ? '' : 'none'; };
        $('menuDeleteBtn').onclick = removeMenu;
        $('menuModal').addEventListener('click', e => { if (e.target === $('menuModal')) closeModal(); });
        wireFloorPos();
        const go = () => {
            loadConfig(); listenMenu(); listenChecks(); listenInhouse(); listenFolio();
            if ($('arcDate')) { $('arcDate').value = todayYmd(); loadArchive(); }
        };
        if (typeof auth !== 'undefined' && auth.onAuthStateChanged) auth.onAuthStateChanged(u => { if (u) go(); });
        else go();
        // Salon kartlarındaki süre/uyarı renklerini canlı tut (yeniden render olmadan)
        setInterval(tickFloor, 30000);
    }
    function tickFloor() {
        if ($('posOverlay') && $('posOverlay').classList.contains('open')) return;
        if ($('view-kds') && $('view-kds').classList.contains('active')) { renderKDS(); return; }
        const fv = $('view-floor'); if (!fv || !fv.classList.contains('active')) return;
        renderFloor();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
