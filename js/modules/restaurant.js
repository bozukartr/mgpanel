/* Hotizy — Restoran (POS) modülü · Faz 1.1: Ayarlar + Menü Yönetimi.
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
    // cfg.currency serbest metin bir GÖSTERİM sembolüdür (admin "₺", "TL", "$"
    // gibi herhangi bir kısa metin girebilir — money()'de tutarın önüne yazılır).
    // Oda hesabına (folioCharges) yazarken bu ham sembol kullanılırsa, Concierge
    // modülünün yazdığı ISO kodlarından ('TRY'/'EUR'/'USD') farklı bir anahtarla
    // gruplanır ve getGuestStay'de AYNI para birimi yanlışlıkla ikiye bölünür
    // (ör. "₺" ile "TRY" ayrı toplamlar olur). Folio yazımı için her zaman ISO
    // koduna çevrilir; concierge.js'deki CUR_SYM ile simetriktir.
    const SYM_TO_ISO = { '₺': 'TRY', 'TL': 'TRY', 'TRY': 'TRY', '€': 'EUR', 'EUR': 'EUR', '$': 'USD', 'USD': 'USD' };
    function currencyIso() {
        const raw = (cfg.currency || '').trim();
        return SYM_TO_ISO[raw] || SYM_TO_ISO[raw.toUpperCase()] || 'TRY';
    }
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
    }

    // Aktif sekmeyi taze veriyle render et (modül içi işlemler sekme değiştirmeden yansısın).
    function renderView(v) {
        if (v === 'floor') renderFloor();
        else if (v === 'stock') renderStock();
        else if (v === 'menu') renderMenu();
        else if (v === 'folio') renderFolio();
        else if (v === 'archive') loadArchive();
        else if (v === 'z') loadZ();
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

    // Rol bazlı sekme erişimi: Staff yalnızca Adisyonlar + Arşiv görür;
    // Manager (ve Admin) diğer sekmeleri (Gün Sonu, Oda Hesapları, Menü, Stok, Ayarlar) de görür.
    const RST_ROLE = ((typeof localStorage !== 'undefined' && localStorage.getItem('hotelRole')) || '').toLowerCase();
    const RST_FULL_ACCESS = (RST_ROLE === 'manager' || RST_ROLE === 'admin');
    const STAFF_TABS = ['floor', 'archive'];
    function applyRoleTabs() {
        if (RST_FULL_ACCESS) return;
        const nav = $('rstSubnav'); if (!nav) return;
        nav.querySelectorAll('.rst-tab').forEach(t => {
            if (STAFF_TABS.indexOf(t.getAttribute('data-view')) === -1) t.style.display = 'none';
        });
        const active = nav.querySelector('.rst-tab.active');
        if (active && STAFF_TABS.indexOf(active.getAttribute('data-view')) === -1) {
            const floorTab = nav.querySelector('.rst-tab[data-view="floor"]');
            if (floorTab) floorTab.click();
        }
    }

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
    function computeStockDecrements(items) {
        const dec = {};
        (items || []).forEach(l => {
            if (!l.menuId) return;
            const mi = menu.find(m => m.id === l.menuId);
            if (mi && mi.trackStock) dec[l.menuId] = (dec[l.menuId] || 0) + (Number(l.qty) || 0);
        });
        return dec;
    }
    function decrementStock(items) {
        const dec = computeStockDecrements(items);
        const ids = Object.keys(dec);
        if (!ids.length) return;
        // FieldValue.increment sınırsızdı — stok negatife düşebiliyordu
        // (envanter kalıcı olarak yanlış kalırdı). Transaction ile mevcut
        // değer okunup düşüm 0'da kilitlenir.
        db.runTransaction(async (tx) => {
            const refs = ids.map(id => db.collection(MENU_COL).doc(id));
            const snaps = await Promise.all(refs.map(ref => tx.get(ref)));
            snaps.forEach((snap, i) => {
                if (!snap.exists) return;
                const cur = Number(snap.data().stock) || 0;
                const next = Math.max(0, cur - dec[ids[i]]);
                tx.update(refs[i], { stock: next, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
            });
        }).catch(err => console.error('stock', err));
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
    // Bu POS oturumunda BU istemcinin bilerek sildiği kalem ID'leri —
    // saveCheck()'in sunucu-taraflı merge'ünde bu ID'lerin "başka bir cihaz
    // ekledi" sanılıp yanlışlıkla geri getirilmemesi (resurrect) için.
    // openPos() her yeni oturumda sıfırlar.
    let removedLineIds = new Set();
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

    let floorSearch = '';
    function checkMatches(c, q) {
        if (!q) return true;
        const hay = [c.tableName, c.name, c.room, c.section, c.checkNo ? '#' + c.checkNo : '', (c.items || []).map(i => i.name).join(' ')].join(' ').toLowerCase();
        return hay.indexOf(q) !== -1;
    }
    function renderFloor() {
        const wrap = $('floorGrid'); if (!wrap) return;
        const dl = $('ckSecList'); if (dl) dl.innerHTML = sectionsOfChecks().map(s => `<option value="${esc(s)}">`).join('');
        const q = floorSearch.trim().toLowerCase();
        const list = openChecks.filter(c => checkMatches(c, q));
        if (!list.length) {
            wrap.innerHTML = q
                ? `<div class="rst-empty">“${esc(floorSearch.trim())}” için açık adisyon bulunamadı.</div>`
                : `<div class="rst-empty">Açık adisyon yok.<br>“+ Adisyon Aç” ile masa no ve kişi sayısı girip başlayın.</div>`;
            return;
        }
        const secs = [];
        list.forEach(c => { const s = c.section || 'Genel'; if (!secs.includes(s)) secs.push(s); });
        secs.sort((a, b) => a.localeCompare(b, 'tr'));
        wrap.innerHTML = secs.map(sec => {
            const cs = list.filter(c => (c.section || 'Genel') === sec).sort(chkByOrder);
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
        // Kimlik: oda bir konaklayan misafire çözülüyorsa adisyon guestId/stayId
        // ile doğar — name/room yalnızca gösterim snapshot'ı (kimlik migrasyonu).
        if (g) { data.guestId = g.id; if (g.activeStayId) data.stayId = g.activeStayId; }
        if (editingCheckId) {
            if (currentCheck && currentCheck.id === editingCheckId) {
                currentCheck.tableName = data.tableName; currentCheck.pax = data.pax; currentCheck.room = data.room; currentCheck.name = data.name; currentCheck.section = data.section;
                setPosHeader(); flushSave();
            } else {
                // version disiplini (Faz 3): kurallar +1'siz güncellemeyi reddeder.
                const editRef = db.collection(CHK_COL).doc(editingCheckId);
                db.runTransaction(async (tx) => {
                    const s = await tx.get(editRef);
                    if (!s.exists || s.data().status === 'paid' || s.data().status === 'void') return;
                    tx.update(editRef, Object.assign({}, data, { version: ((s.data().version) || 0) + 1 }));
                }).catch(err => console.error(err));
            }
            closeCheckModal(); toast('Adisyon güncellendi.');
        } else {
            // Aynı masa adıyla zaten açık/gönderilmiş bir adisyon varsa yenisini
            // açmadan önce uyar — önce yerel önbellekle hızlı bir ön-kontrol
            // (aynı UX), ama nihai karar her zaman restTables kilit belgesini
            // BİR transaction içinde okuyup yazan openTableCheck() içinde
            // verilir — iki garson aynı masa için aynı anda "Adisyonu Aç"a
            // basarsa, ikincisinin transaction'ı ilkinin commit'ini görüp
            // gerçek çakışmayı bildirir (yalnızca önbellek taraması artık
            // bunu kaçırabiliyordu).
            const dup = (openChecks || []).find(c => c.tableName === data.tableName);
            if (dup) {
                const proceed = confirm(`"${data.tableName}" masasında zaten açık bir adisyon var (#${dup.checkNo || dup.id}).\n\nYine de yeni bir adisyon açmak istiyor musunuz?`);
                if (!proceed) return;
            }
            openTableCheck(data, /* skipLockCheck */ !!dup);
        }
    }
    // ── Sunucu tarafı adisyon açma (restOpenCheck callable) ─────────
    // Tek sunucu transaction'ında checkNo + masa kilidi + adisyon;
    // operationId ile çift tıklama/tekrar istek idempotent. Fonksiyon
    // henüz deploy edilmemişse (not-found) eski istemci yoluna düşer.
    // Hata kodları: docs/restoran-uretim-plani.md §2.
    function newOperationId() {
        return 'op' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    const REST_ERR_MSG = {
        'REST/TABLE_OCCUPIED': 'Bu masada zaten açık bir adisyon var.',
        'REST/INVALID_INPUT': 'Eksik/geçersiz bilgi — masa adını kontrol edin.',
        'REST/ROLE_DENIED': 'Bu işlem için yetkiniz yok.',
        'REST/TENANT_MISMATCH': 'Bu kayıt sizin otelinize ait değil.',
        'REST/CHECK_IMMUTABLE': 'Adisyon ödenmiş/iptal edilmiş — değiştirilemez.',
        'REST/OVERPAY_NONCASH': 'Kart/oda ödemesi kalan tutarı aşamaz.',
        'REST/NO_PAYMENT': 'Ödeme tutarı yetersiz.',
        'REST/REASON_REQUIRED': 'Bu işlem için sebep girilmesi zorunlu.'
    };
    function restErrMsg(err, fallback) {
        const det = (err && err.details) || {};
        if (det.errCode && REST_ERR_MSG[det.errCode]) return REST_ERR_MSG[det.errCode];
        return fallback + (err && err.message ? ' (' + err.message + ')' : '');
    }
    function isFnMissing(err) {
        const c = String((err && err.code) || '');
        return c === 'not-found' || c === 'functions/not-found' || c === 'unimplemented' || /not.?found/i.test(String(err && err.message));
    }
    function openTableCheck(data, skipLockCheck) {
        const g = guestByRoom(data.room);
        const call = firebase.app().functions('us-central1').httpsCallable('restOpenCheck');
        call({
            operationId: newOperationId(),
            tableName: data.tableName, pax: data.pax, section: data.section,
            room: data.room, name: data.name,
            guestId: (g && g.id) || data.guestId || '', stayId: (g && g.activeStayId) || data.stayId || '',
            force: !!skipLockCheck
        }).then(res => {
            closeCheckModal();
            openPos({ id: res.data.checkId, checkNo: res.data.checkNo || null, tableName: data.tableName, pax: data.pax, room: data.room, name: data.name, section: data.section, status: 'open', items: [] });
        }).catch(err => {
            const det = (err && err.details) || {};
            if (det.errCode === 'REST/TABLE_OCCUPIED') {
                const proceed = confirm(`"${data.tableName}" masasında zaten açık bir adisyon var (#${det.checkNo || det.checkId || '?'}).\n\nYine de yeni bir adisyon açmak istiyor musunuz?`);
                if (proceed) openTableCheck(data, true);
                return;
            }
            if (isFnMissing(err)) { legacyOpenTableCheck(data, skipLockCheck); return; } // geçiş dönemi
            console.error(err);
            toast(restErrMsg(err, 'Adisyon açılamadı'), true);
        });
    }

    // restTables/{tenantId}__{tableKey} — hangi açık adisyonun o masayı
    // tuttuğuna dair sunucu-taraflı kilit. Firebase 8.x compat SDK
    // transaction içinde sorgu desteklemediğinden ("no query in tx"),
    // masa başına deterministik bir kilit dokümanı kullanılır.
    // tableKeyOf: functions/rest-core.js tableKey ile AYNI normalizasyon.
    function tableKeyOf(name) {
        return String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR').replace(/\//g, '_').slice(0, 60);
    }
    function tableLockRef(tableName) {
        return db.collection('restTables').doc(TENANT_ID + '__' + tableKeyOf(tableName));
    }
    // LEGACY kilit kimliği (normalizasyon öncesi biçim) — onarım migration'ı
    // (restRepairTableLocks) çalışana kadar eski kilitler bu kimlikte olabilir.
    function legacyTableLockRef(tableName) {
        return db.collection('restTables').doc(TENANT_ID + '__' + String(tableName || '').replace(/\//g, '_').slice(0, 60));
    }
    // LEGACY: restOpenCheck fonksiyonu deploy edilene kadarki istemci yolu.
    function legacyOpenTableCheck(data, skipLockCheck) {
        const TS = firebase.firestore.FieldValue.serverTimestamp();
        const lockRef = tableLockRef(data.tableName);
        nextCheckNo().catch(() => null).then(no => {
            const payload = Object.assign({
                tenantId: TENANT_ID, status: 'open', version: 1, tableKey: tableKeyOf(data.tableName), items: [], subtotal: 0, vat: 0, total: 0, openedBy: loggedUser, openedAt: TS
            }, data);
            if (no) payload.checkNo = no;
            const checkRef = db.collection(CHK_COL).doc();
            db.runTransaction(async (tx) => {
                if (!skipLockCheck) {
                    const lockSnap = await tx.get(lockRef);
                    const openId = lockSnap.exists ? lockSnap.data().openCheckId : null;
                    if (openId) {
                        const openSnap = await tx.get(db.collection(CHK_COL).doc(openId));
                        if (openSnap.exists && (openSnap.data().status === 'open' || openSnap.data().status === 'sent')) {
                            const err = new Error('table-open');
                            err.code = 'table-open';
                            err.checkNo = openSnap.data().checkNo || openId;
                            throw err;
                        }
                    }
                }
                tx.set(checkRef, payload);
                tx.set(lockRef, { tenantId: TENANT_ID, table: data.tableName, openCheckId: checkRef.id, updatedAt: TS });
            }).then(() => {
                closeCheckModal();
                openPos({ id: checkRef.id, checkNo: no || null, tableName: data.tableName, pax: data.pax, room: data.room, name: data.name, section: data.section, status: 'open', items: [] });
            }).catch(err => {
                if (err && err.code === 'table-open') {
                    const proceed = confirm(`"${data.tableName}" masasında zaten açık bir adisyon var (#${err.checkNo}).\n\nYine de yeni bir adisyon açmak istiyor musunuz?`);
                    if (proceed) openTableCheck(data, true);
                    return;
                }
                console.error(err); toast('Açılamadı.', true);
            });
        });
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
        // Durum filtresi SUNUCUDA: önceden tüm adisyon tarihçesi (kapalı
        // binlerce kayıt dahil) canlı dinlenip açık/gönderilmiş ayrımı
        // istemcide yapılıyordu — her değişimde tüm geçmiş yeniden
        // taşınıyordu (bkz. hız denetimi). (tenantId, status) bileşik
        // indeksi zaten mevcut.
        db.collection(CHK_COL).where('tenantId', '==', TENANT_ID)
            .where('status', 'in', ['open', 'sent']).onSnapshot(snap => {
                openChecks = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
                renderFloor();
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
    }
    function openPos(check) {
        currentCheck = JSON.parse(JSON.stringify(check));
        if (!currentCheck.items) currentCheck.items = [];
        removedLineIds = new Set();
        selectedLineId = null;
        setPosPane('menu');
        setPosHeader();
        posCat = ''; posSearch = '';
        if ($('posSearch')) $('posSearch').value = '';
        renderPosMenu();
        renderPosCheck();
        $('posOverlay').classList.add('open');
    }
    function closePos() { flushSave(); $('posOverlay').classList.remove('open'); currentCheck = null; }

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
        const apply = () => {
            l.qty += d;
            if (l.qty <= 0) { currentCheck.items = currentCheck.items.filter(x => x.lineId !== lineId); removedLineIds.add(lineId); if (selectedLineId === lineId) selectedLineId = null; }
            recalcSave();
        };
        if (d < 0 && l.sent) authorizeCancel(apply); else apply();
    }
    function removeLine(lineId) {
        const l = currentCheck.items.find(x => x.lineId === lineId);
        const doRemove = () => {
            currentCheck.items = currentCheck.items.filter(x => x.lineId !== lineId);
            removedLineIds.add(lineId);
            if (selectedLineId === lineId) selectedLineId = null;
            recalcSave();
        };
        if (l && l.sent) authorizeCancel(doRemove); else doRemove();
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
    let splitMove = {};   // lineId -> ayrılacak adet
    let splitN = 2;       // eşit böl parça sayısı
    function newLineId() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
    function splitUnitPrice(l) { return l.ikram ? 0 : round2(Number(l.unitPrice) || 0); }
    function totalUnits() { return currentCheck.items.reduce((s, l) => s + (l.qty || 1), 0); }

    function openSplit() {
        if (!currentCheck || !currentCheck.items.length) { toast('Bölünecek kalem yok.', true); return; }
        if (computeTotals(currentCheck.items).total <= 0) { toast('Bölünecek tutar yok.', true); return; }
        splitMove = {}; splitN = 2;
        setSplitMode('manual');
        renderSplitManual();
        renderSplitEqual();
        $('splitModal').classList.add('open');
    }
    function setSplitMode(m) {
        document.querySelectorAll('.rst-split-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-smode') === m));
        if ($('splitManual')) $('splitManual').style.display = m === 'manual' ? '' : 'none';
        if ($('splitEqual')) $('splitEqual').style.display = m === 'equal' ? '' : 'none';
    }
    // ── Kalem seç (kısmi adet) ──
    function renderSplitManual() {
        $('splitList').innerHTML = currentCheck.items.map(l => {
            const mv = splitMove[l.lineId] || 0;
            return `<div class="rst-split-row2" data-sl="${esc(l.lineId)}">
                <div class="rst-sl-info">
                    <span class="rst-sl-n">${esc(l.name)}${l.ikram ? ' <span class="rst-line-ik">İKRAM</span>' : ''}</span>
                    <span class="rst-sl-p">${esc(money(splitUnitPrice(l)))} × ${esc(l.qty)}</span>
                </div>
                <div class="rst-sl-qty">
                    <button type="button" data-sd="-1" aria-label="azalt">−</button>
                    <span class="rst-sl-mv">${mv}</span><small>/ ${esc(l.qty)}</small>
                    <button type="button" data-sd="1" aria-label="arttır">+</button>
                </div>
            </div>`;
        }).join('');
        $('splitList').querySelectorAll('.rst-split-row2').forEach(row => {
            const id = row.getAttribute('data-sl');
            row.querySelectorAll('[data-sd]').forEach(b => b.onclick = () => {
                const l = currentCheck.items.find(x => x.lineId === id); if (!l) return;
                const next = Math.max(0, Math.min(l.qty || 1, (splitMove[id] || 0) + (+b.getAttribute('data-sd'))));
                splitMove[id] = next;
                row.querySelector('.rst-sl-mv').textContent = next;
                updateSplitSum();
            });
        });
        updateSplitSum();
    }
    function updateSplitSum() {
        let mVal = 0, mUnits = 0;
        currentCheck.items.forEach(l => { const mv = splitMove[l.lineId] || 0; mVal += mv * splitUnitPrice(l); mUnits += mv; });
        const remain = totalUnits() - mUnits;
        if ($('splitSum')) $('splitSum').innerHTML = `Taşınan: <b>${mUnits} adet · ${esc(money(round2(mVal)))}</b> &nbsp;·&nbsp; Kalan: <b>${remain} adet</b>`;
    }
    function doSplit() {
        const moves = currentCheck.items.map(l => ({ l: l, mv: Math.max(0, Math.min(l.qty || 1, splitMove[l.lineId] || 0)) })).filter(x => x.mv > 0);
        if (!moves.length) { toast('Ayrılacak adet seçin.', true); return; }
        const mUnits = moves.reduce((s, x) => s + x.mv, 0);
        if (mUnits >= totalUnits()) { toast('Tüm adetler ayrılamaz — en az 1 adet kalmalı.', true); return; }
        const moved = [];
        moves.forEach(({ l, mv }) => {
            if (mv >= (l.qty || 1)) { moved.push(Object.assign({}, l)); l.qty = 0; removedLineIds.add(l.lineId); }
            else { moved.push(Object.assign({}, l, { lineId: newLineId(), qty: mv })); l.qty -= mv; }
        });
        currentCheck.items = currentCheck.items.filter(l => (l.qty || 0) > 0);
        createSplitChecks([{ items: moved, suffix: '(B)' }]).then(nos => {
            recalcSave(); flushSave();
            $('splitModal').classList.remove('open');
            toast('Adisyon bölündü' + (nos[0] ? ' → #' + nos[0] : '') + '.');
        });
    }
    // ── Eşit böl (TUTAR bazlı — toplam N eşit paya bölünür) ──
    function equalShares(total, n) {
        const base = Math.floor((total / n) * 100) / 100;
        const shares = []; for (let i = 0; i < n; i++) shares.push(base);
        shares[n - 1] = round2(total - base * (n - 1)); // yuvarlama farkı son paya
        return shares;
    }
    // Pay tutarını temsil eden sentetik kalem; computeTotals ile tam paya eşitlenir.
    function shareLine(share, k, n) {
        const r = Number(cfg.vatRate) || 0;
        const unit = (cfg.vatMode === 'excluded' && r > 0) ? round2(share / (1 + r / 100)) : round2(share);
        return {
            lineId: newLineId(), menuId: null, name: 'Eşit Pay (' + k + '/' + n + ')', category: 'Bölüm',
            unitPrice: unit, qty: 1, vatRate: (r || null), station: 'kitchen',
            note: (currentCheck.tableName ? 'Masa ' + currentCheck.tableName + ' · ' : '') + n + ' eşit pay',
            sent: true, served: true, ready: true
        };
    }
    function renderSplitEqual() {
        if (splitN < 2) splitN = 2; if (splitN > 8) splitN = 8;
        const ns = []; for (let i = 2; i <= 8; i++) ns.push(i);
        $('splitEqN').innerHTML = ns.map(n => `<button type="button" class="rst-eq-btn${n === splitN ? ' active' : ''}" data-n="${n}">${n}</button>`).join('');
        $('splitEqN').querySelectorAll('[data-n]').forEach(b => b.onclick = () => { splitN = +b.getAttribute('data-n'); renderSplitEqual(); });
        const total = computeTotals(currentCheck.items).total;
        const shares = equalShares(total, splitN);
        $('splitEqPreview').innerHTML = `<div class="rst-eq-head">Toplam <b>${esc(money(total))}</b> → ${splitN} eşit pay</div>`
            + shares.map((s, i) => `<div class="rst-eq-part">
                <div class="rst-eq-part-h"><b>Pay ${i + 1}${i === 0 ? ' (mevcut adisyon)' : ''}</b><span>${esc(money(s))}</span></div>
            </div>`).join('');
    }
    function doSplitEqual() {
        const total = computeTotals(currentCheck.items).total;
        if (total <= 0) { toast('Bölünecek tutar yok.', true); return; }
        const n = splitN;
        const shares = equalShares(total, n);
        const group = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const doPrint = $('splitEqPrint') ? $('splitEqPrint').checked : false;
        const table = currentCheck.tableName || '', baseName = currentCheck.name || '';
        // Eşit bölme, gerçek kalemleri (menuId'li) tutar bazlı sentetik "Eşit
        // Pay" kalemleriyle değiştirir — bu kalemler menuId taşımadığı için
        // settle()'daki decrementStock() hiçbir zaman tetiklenmez ve stok asla
        // düşmezdi. Kalemler zaten hazırlanıp servis edilmiş (sent/served/ready)
        // olduğundan, bölünmeden önce ORİJİNAL kalemler üzerinden stoğu burada
        // bir kez düşüyoruz; sonraki N parçanın hiçbiri gerçek menuId taşımadığı
        // için tekrar düşme riski yok.
        if (!currentCheck.id) { toast('Önce adisyonu kaydedin.', true); return; }

        // Bölme önce SUNUCUDA (F4.5 — restSplitCheck: paylar sunucudaki
        // kalemlerden hesaplanır, STOK DÜŞÜMÜ DAHİL tek transaction + audit);
        // fonksiyon yoksa Faz 3 istemci yoluna düşer.
        const callSplit = firebase.app().functions('us-central1').httpsCallable('restSplitCheck');
        callSplit({ operationId: newOperationId(), checkId: currentCheck.id, parts: n })
            .then(res => {
                const d = res.data || {};
                currentCheck.items = [shareLine(d.firstShare != null ? d.firstShare : shares[0], 1, n)];
                currentCheck.splitGroup = d.group || group;
                currentCheck.status = 'sent';
                const t0 = computeTotals(currentCheck.items);
                currentCheck.subtotal = t0.subtotal; currentCheck.vat = t0.vat; currentCheck.total = t0.total;
                renderPosCheck();
                $('splitModal').classList.remove('open');
                toast(n + ' eşit paya bölündü.');
                if (doPrint) {
                    const objs = [receiptObjFromCheck(currentCheck)];
                    (d.parts || []).forEach(p => objs.push(receiptObjFromCheck({ checkNo: p.checkNo, tableName: table, name: (baseName ? baseName + ' ' : '') + '(' + p.checkNo + ')', room: '', pax: 1, items: [{ lineId: 'x', name: 'Eşit Pay', qty: 1, unitPrice: p.amount }] })));
                    printReceiptList(objs);
                }
            })
            .catch(err => {
                if (!isFnMissing(err)) { console.error(err); toast(restErrMsg(err, 'Bölme tamamlanamadı'), true); return; }
                legacySplitTx();
            });
        return;

        function legacySplitTx() {
        decrementStock(currentCheck.items);

        // ATOMİK bölme (Faz 3): sayaç + mevcut adisyonun güncellenmesi + tüm
        // yeni parçalar TEK transaction — ağ kesintisinde ya hepsi ya hiçbiri
        // (önceden sıralı add zinciriydi, yarıda kalabiliyordu).
        const newParts = [];
        for (let k = 1; k < n; k++) newParts.push({ items: [shareLine(shares[k], k + 1, n)], suffix: '(' + (k + 1) + '/' + n + ')', splitGroup: group });
        const firstItems = [shareLine(shares[0], 1, n)];
        const checkRef = db.collection(CHK_COL).doc(currentCheck.id);
        const counterRef = db.collection(COUNTER_COL).doc(TENANT_ID);
        const TS = firebase.firestore.FieldValue.serverTimestamp();
        db.runTransaction(async (tx) => {
            const cSnap = await tx.get(checkRef);
            if (!cSnap.exists) throw new Error('adisyon-yok');
            if (cSnap.data().status === 'paid' || cSnap.data().status === 'void') throw new Error('degistirilemez');
            const cntSnap = await tx.get(counterRef);
            let no = ((cntSnap.exists && cntSnap.data().checkNo) || 0);
            const t0 = computeTotals(firstItems);
            tx.update(checkRef, {
                items: firstItems, splitGroup: group, status: 'sent',
                subtotal: t0.subtotal, vat: t0.vat, total: t0.total,
                version: ((cSnap.data().version) || 0) + 1, updatedAt: TS
            });
            const nos = [];
            newParts.forEach(part => {
                no += 1; nos.push(no);
                const t = computeTotals(part.items);
                tx.set(db.collection(CHK_COL).doc(), {
                    tenantId: TENANT_ID, tableName: table,
                    tableKey: tableKeyOf(table),
                    name: (baseName ? baseName + ' ' : '') + part.suffix,
                    room: '', section: currentCheck.section || 'Genel', status: 'sent', pax: 1, note: '',
                    items: part.items, subtotal: t.subtotal, vat: t.vat, total: t.total,
                    version: 1, checkNo: no, splitGroup: part.splitGroup,
                    sentAt: Date.now(), openedBy: loggedUser, openedAt: TS
                });
            });
            tx.set(counterRef, { tenantId: TENANT_ID, checkNo: no, updatedAt: TS }, { merge: true });
            return nos;
        }).then(nos => {
            currentCheck.items = firstItems;
            currentCheck.splitGroup = group;
            currentCheck.status = 'sent';
            const t0 = computeTotals(firstItems);
            currentCheck.subtotal = t0.subtotal; currentCheck.vat = t0.vat; currentCheck.total = t0.total;
            renderPosCheck();
            $('splitModal').classList.remove('open');
            toast(n + ' eşit paya bölündü.');
            if (doPrint) {
                const objs = [receiptObjFromCheck(currentCheck)];
                newParts.forEach((p, i) => objs.push(receiptObjFromCheck({ checkNo: nos[i], tableName: table, name: (baseName ? baseName + ' ' : '') + p.suffix, room: '', pax: 1, items: p.items })));
                printReceiptList(objs);
            }
        }).catch(err => {
            console.error(err);
            toast('Bölme tamamlanamadı — hiçbir değişiklik yapılmadı.', true);
        });
        }
    }
    // Bir bölme grubundaki tüm adisyonların fişini arka arkaya yazdır.
    function printSplitGroup() {
        const g = currentCheck && currentCheck.splitGroup; if (!g) return;
        const list = openChecks.filter(c => c.splitGroup === g).slice();
        if (currentCheck.id && !list.some(c => c.id === currentCheck.id)) list.unshift(currentCheck);
        if (!list.length) list.push(currentCheck);
        list.sort((a, b) => (a.checkNo || 0) - (b.checkNo || 0));
        printReceiptList(list.map(receiptObjFromCheck));
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
        if (!other || !currentCheck || !currentCheck.id) return;
        if (!confirm('Masa ' + (other.tableName || '') + (other.checkNo ? ' (#' + other.checkNo + ')' : '') + ' adisyonu bu adisyona birleştirilsin mi? Diğer adisyon kapanır.')) return;
        // Birleştirme önce SUNUCUDA (F4.5 — restMergeChecks: audit +
        // idempotency); fonksiyon yoksa Faz 3 istemci transaction'ına düşer.
        const callMerge = firebase.app().functions('us-central1').httpsCallable('restMergeChecks');
        callMerge({ operationId: newOperationId(), checkId: currentCheck.id, otherId: otherId })
            .then(() => db.collection(CHK_COL).doc(currentCheck.id).get())
            .then(snap => {
                if (snap.exists) {
                    const d = snap.data();
                    currentCheck.items = d.items || []; currentCheck.pax = d.pax; currentCheck.status = d.status;
                    currentCheck.subtotal = d.subtotal; currentCheck.vat = d.vat; currentCheck.total = d.total;
                }
                renderPosCheck();
                $('mergeModal').classList.remove('open');
                toast('Adisyonlar birleştirildi.');
            })
            .catch(err => {
                if (!isFnMissing(err)) { console.error(err); toast(restErrMsg(err, 'Birleştirme tamamlanamadı'), true); return; }
                legacyMergeTx();
            });
        function legacyMergeTx() {
        // ATOMİK birleştirme (Faz 3): iki adisyonun SUNUCUDAKİ güncel halleri
        // tek transaction'da okunur; hedef güncellenir + kaynak silinir +
        // kaynağın masa kilidi temizlenir — ağ kesintisinde yarım kalmaz
        // (önceden delete ve save ayrı isteklerdi).
        const curRef = db.collection(CHK_COL).doc(currentCheck.id);
        const othRef = db.collection(CHK_COL).doc(otherId);
        const othLockN = tableLockRef(other.tableName);
        const othLockL = legacyTableLockRef(other.tableName);
        db.runTransaction(async (tx) => {
            const [curSnap, othSnap, lockN, lockL] = await Promise.all([
                tx.get(curRef), tx.get(othRef), tx.get(othLockN), tx.get(othLockL)
            ]);
            if (!curSnap.exists || !othSnap.exists) throw new Error('adisyon-yok');
            const cs = curSnap.data(), os = othSnap.data();
            if (['paid', 'void'].includes(cs.status) || ['paid', 'void'].includes(os.status)) throw new Error('degistirilemez');
            const curItems = Array.isArray(cs.items) ? cs.items : [];
            const othItems = (Array.isArray(os.items) ? os.items : []).map(l => Object.assign({}, l));
            const merged = curItems.concat(othItems);
            const t = computeTotals(merged);
            const notes = [cs.note, os.note].filter(Boolean);
            tx.update(curRef, {
                items: merged,
                pax: (Number(cs.pax) || 1) + (Number(os.pax) || 0),
                note: notes.length ? notes.join(' · ').slice(0, 160) : (cs.note || ''),
                subtotal: t.subtotal, vat: t.vat, total: t.total,
                status: (cs.status === 'sent' || os.status === 'sent') ? 'sent' : cs.status,
                version: ((cs.version) || 0) + 1,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            tx.delete(othRef);
            if (lockN.exists && lockN.data().openCheckId === otherId) tx.delete(othLockN);
            if (othLockL.path !== othLockN.path && lockL.exists && lockL.data().openCheckId === otherId) tx.delete(othLockL);
            return { merged, t, pax: (Number(cs.pax) || 1) + (Number(os.pax) || 0), status: (cs.status === 'sent' || os.status === 'sent') ? 'sent' : cs.status };
        }).then(r => {
            currentCheck.items = r.merged;
            currentCheck.pax = r.pax;
            currentCheck.status = r.status;
            currentCheck.subtotal = r.t.subtotal; currentCheck.vat = r.t.vat; currentCheck.total = r.t.total;
            renderPosCheck();
            $('mergeModal').classList.remove('open');
            toast('Adisyonlar birleştirildi.');
        }).catch(err => {
            console.error(err);
            toast('Birleştirme tamamlanamadı — hiçbir değişiklik yapılmadı.', true);
        });
        }
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
        const newTable = t.replace(/\s+/g, ' ').slice(0, 20);
        const newSection = ($('transferSection').value || 'Genel').trim().slice(0, 30) || 'Genel';

        // Henüz kaydedilmemiş (id'siz) adisyonda taşıma yalnız yerel.
        if (!currentCheck.id) {
            currentCheck.tableName = newTable; currentCheck.section = newSection;
            setPosHeader(); if (currentCheck.items.length) flushSave();
            $('transferModal').classList.remove('open');
            toast('Adisyon Masa ' + newTable + ' konumuna taşındı.');
            return;
        }

        // Taşıma önce SUNUCUDA (F4.5 — restTransferCheck: kilit tutarlılığı +
        // audit + idempotency); fonksiyon deploy edilmemişse Faz 3'ün
        // istemci transaction'ına düşer (kurallar zaten sınırlıyor).
        const applyLocal = () => {
            currentCheck.tableName = newTable; currentCheck.section = newSection;
            setPosHeader();
            $('transferModal').classList.remove('open');
            toast('Adisyon Masa ' + newTable + ' konumuna taşındı.');
        };
        const callTransfer = firebase.app().functions('us-central1').httpsCallable('restTransferCheck');
        callTransfer({ operationId: newOperationId(), checkId: currentCheck.id, newTable: newTable, newSection: newSection })
            .then(applyLocal)
            .catch(err => {
                const det = (err && err.details) || {};
                if (det.errCode === 'REST/TABLE_OCCUPIED') { toast('Hedef masada zaten açık bir adisyon var (#' + (det.checkNo || '?') + ').', true); return; }
                if (!isFnMissing(err)) { console.error(err); toast(restErrMsg(err, 'Taşıma tamamlanamadı'), true); return; }
                legacyTransferTx();
            });
        function legacyTransferTx() {
        // ATOMİK taşıma (Faz 3): hedef masa doluysa reddet; adisyon güncelle +
        // eski kilidi sil + yeni kilidi yaz — hepsi tek transaction.
        const checkRef = db.collection(CHK_COL).doc(currentCheck.id);
        const oldLockN = tableLockRef(currentCheck.tableName);
        const oldLockL = legacyTableLockRef(currentCheck.tableName);
        const newLock = tableLockRef(newTable);
        db.runTransaction(async (tx) => {
            const [cSnap, nSnap, oN, oL] = await Promise.all([
                tx.get(checkRef), tx.get(newLock), tx.get(oldLockN), tx.get(oldLockL)
            ]);
            if (!cSnap.exists) throw new Error('adisyon-yok');
            const cs = cSnap.data();
            if (cs.status === 'paid' || cs.status === 'void') throw new Error('degistirilemez');
            // Hedef masada BAŞKA bir açık adisyonun kilidi varsa reddet.
            if (nSnap.exists && nSnap.data().openCheckId && nSnap.data().openCheckId !== currentCheck.id) {
                const occ = await tx.get(db.collection(CHK_COL).doc(nSnap.data().openCheckId));
                if (occ.exists && (occ.data().status === 'open' || occ.data().status === 'sent')) {
                    const err = new Error('masa-dolu'); err.masaDolu = true; err.checkNo = occ.data().checkNo; throw err;
                }
            }
            tx.update(checkRef, {
                tableName: newTable, tableKey: tableKeyOf(newTable), section: newSection,
                version: ((cs.version) || 0) + 1,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            if (oN.exists && oN.data().openCheckId === currentCheck.id && oldLockN.path !== newLock.path) tx.delete(oldLockN);
            if (oldLockL.path !== oldLockN.path && oL.exists && oL.data().openCheckId === currentCheck.id) tx.delete(oldLockL);
            tx.set(newLock, {
                tenantId: TENANT_ID, table: newTable, tableKey: tableKeyOf(newTable),
                openCheckId: currentCheck.id, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }).then(() => {
            currentCheck.tableName = newTable; currentCheck.section = newSection;
            setPosHeader();
            $('transferModal').classList.remove('open');
            toast('Adisyon Masa ' + newTable + ' konumuna taşındı.');
        }).catch(err => {
            if (err && err.masaDolu) { toast('Hedef masada zaten açık bir adisyon var (#' + (err.checkNo || '?') + ').', true); return; }
            console.error(err);
            toast('Taşıma tamamlanamadı — hiçbir değişiklik yapılmadı.', true);
        });
        }
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
        const meta = {
            tenantId: TENANT_ID, tableName: currentCheck.tableName || '', name: currentCheck.name || '', room: currentCheck.room || '',
            section: currentCheck.section || 'Genel', status: currentCheck.status || 'open', pax: currentCheck.pax || 1, note: currentCheck.note || '',
            sentAt: currentCheck.sentAt || null, splitGroup: currentCheck.splitGroup || null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (!currentCheck.id) {
            const payload = Object.assign({}, meta, {
                items: currentCheck.items, subtotal: currentCheck.subtotal || 0, vat: currentCheck.vat || 0, total: currentCheck.total || 0,
                version: 1, tableKey: (currentCheck.tableName || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR').replace(/\//g, '_').slice(0, 60),
                openedBy: loggedUser, openedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            db.collection(CHK_COL).add(payload).then(ref => { currentCheck.id = ref.id; }).catch(err => console.error(err));
            return;
        }
        // Var olan bir adisyona kayıt: kör "tüm items dizisinin üzerine yaz"
        // yerine (bkz. idempotency denetimi — bu, iki personel aynı adisyonu
        // eşzamanlı düzenlerse birinin eklediği kalemlerin diğerinin
        // kaydıyla SESSİZCE SİLİNMESİNE yol açıyordu), yazımdan hemen önce
        // sunucudaki EN GÜNCEL items'ı bir transaction içinde yeniden okuyup
        // bu istemcinin yerel kopyasıyla birleştiriyoruz: yalnızca sunucuda
        // olup yerelde bilinmeyen VE bu oturumda bilerek silinmemiş kalemler
        // (yani başka bir cihazın eklediği kalemler) korunarak eklenir.
        // (arrayUnion kullanılmadı: satır objeleri qty/sent/note gibi
        // değişen alanlar taşıyor, arrayUnion deep-equality ile çalıştığından
        // bir miktar güncellemesi mevcut satırı GÜNCELLEMEZ, mükerrer yeni
        // bir satır ekler — bu veri şekli için transaction-bazlı merge daha
        // doğru.)
        const ref = db.collection(CHK_COL).doc(currentCheck.id);
        const localItems = currentCheck.items;
        db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            // ÖDENMİŞ/İPTAL adisyona gecikmeli kayıt YAZILMAZ (Faz 3):
            // debounce'lu saveCheck ödemeden sonra tetiklenirse önceden
            // ödenmiş adisyonun kalemlerini değiştirebiliyordu — kurallar da
            // artık reddeder; burada erken çıkıp kullanıcıyı bilgilendiriyoruz.
            if (snap.exists && (snap.data().status === 'paid' || snap.data().status === 'void')) {
                return { blocked: snap.data().status };
            }
            const serverItems = (snap.exists && Array.isArray(snap.data().items)) ? snap.data().items : [];
            const localIds = new Set(localItems.map(l => l.lineId));
            const onlyOnServer = serverItems.filter(l => l && l.lineId && !localIds.has(l.lineId) && !removedLineIds.has(l.lineId));
            const merged = localItems.concat(onlyOnServer);
            const t = computeTotals(merged);
            tx.update(ref, Object.assign({}, meta, {
                items: merged, subtotal: t.subtotal, vat: t.vat, total: t.total,
                version: ((snap.exists && snap.data().version) || 0) + 1
            }));
            return { ok: true };
        }).then(r => {
            if (r && r.blocked) toast('Bu adisyon ' + (r.blocked === 'paid' ? 'ödenmiş' : 'iptal edilmiş') + ' — değişiklik kaydedilmedi.', true);
        }).catch(err => console.error(err));
    }
    function sendKitchen() {
        if (!currentCheck || !currentCheck.items.length) { toast('Adisyon boş.', true); return; }
        const freshItems = currentCheck.items.filter(l => !l.sent);
        const fresh = freshItems.length;
        currentCheck.items.forEach(l => l.sent = true);
        currentCheck.status = 'sent';
        if (fresh || !currentCheck.sentAt) currentCheck.sentAt = Date.now();
        const t = computeTotals(currentCheck.items);
        currentCheck.subtotal = t.subtotal; currentCheck.vat = t.vat; currentCheck.total = t.total;
        renderPosCheck(); flushSave();
        printOrderTicket(currentCheck, fresh ? freshItems : currentCheck.items);
        toast(fresh ? fresh + ' kalem için sipariş fişi yazdırıldı.' : 'Sipariş fişi yeniden yazdırıldı.');
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
    // ── Sipariş fişi (mutfağa elden verilen, fiyatsız) ──────────
    function printOrderTicket(c, items) {
        if (!items || !items.length) return;
        const w = window.open('', '_blank', 'width=380,height=600');
        if (!w) { toast('Açılır pencere engellendi (sipariş fişi).', true); return; }
        const now = new Date(); const p = n => n < 10 ? '0' + n : '' + n;
        const time = p(now.getDate()) + '.' + p(now.getMonth() + 1) + '.' + now.getFullYear() + ' ' + p(now.getHours()) + ':' + p(now.getMinutes());
        const rows = items.map(l => `<tr><td class="q">${esc(l.qty)}×</td><td>${esc(l.name)}${l.station === 'bar' ? ' [BAR]' : ''}${l.ikram ? ' (İkram)' : ''}${l.note ? '<div class="note">» ' + esc(l.note) + '</div>' : ''}</td></tr>`).join('');
        w.document.write(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Sipariş Fişi</title>
<style>
 @page{size:80mm auto;margin:0}
 *{box-sizing:border-box}
 body{width:80mm;margin:0;padding:8px 10px;font-family:'Courier New',monospace;font-size:13px;color:#000}
 h1{font-size:16px;margin:0 0 2px;text-align:center;letter-spacing:1px}
 .sub{text-align:center;font-size:12px;margin-bottom:4px}
 hr{border:none;border-top:1px dashed #000;margin:6px 0}
 table{width:100%;border-collapse:collapse}
 td{padding:3px 0;vertical-align:top;font-size:14px;font-weight:bold}
 td.q{width:34px}
 .note{font-size:11px;font-weight:normal;color:#222}
</style></head><body>
<h1>SİPARİŞ FİŞİ</h1>
<div class="sub">${c.checkNo ? 'Adisyon #' + esc(c.checkNo) + ' · ' : ''}Masa ${esc(c.tableName || '')}${c.room ? ' · Oda ' + esc(c.room) : ''} · ${esc(c.pax || 1)} kişi</div>
<div class="sub">${esc(loggedUser)} · ${esc(time)}</div>
<hr>
<table>${rows}</table>
${c.note ? '<hr><div class="note">Adisyon notu: ' + esc(c.note) + '</div>' : ''}
<scr` + `ipt>window.onload=function(){setTimeout(function(){window.print();},250);}</scr` + `ipt>
</body></html>`);
        w.document.close();
    }
    // İPTAL artık SUNUCUDA (Faz 4 — restVoidCheck): düz metin cancelCode
    // KALDIRILDI. Gönderilmiş kalemli iptal, OTURUM AÇMIŞ kullanıcının
    // manager/admin olmasını ister (yetkili UID + sebep + tarih audit'e
    // yazılır); garson cihazında yönetici kendi hesabıyla giriş yapmalı.
    // Stok düşümü ve masa kilidi temizliği sunucu transaction'ında.
    function voidCheck() {
        if (!currentCheck) return;
        if (!currentCheck.id) { $('posOverlay').classList.remove('open'); currentCheck = null; return; }
        const sentItems = (currentCheck.items || []).filter(l => l.sent);
        let reason = '';
        if (sentItems.length) {
            const r = prompt('İptal sebebi (zorunlu — denetim kaydına yazılır):');
            if (r === null) return;
            reason = String(r).trim();
            if (!reason) { toast('Sebep girilmeden iptal edilemez.', true); return; }
        }
        if (!confirm('Adisyon iptal edilsin mi? (Masa boşalır)')) return;
        flushSave();
        const call = firebase.app().functions('us-central1').httpsCallable('restVoidCheck');
        call({ operationId: newOperationId(), checkId: currentCheck.id, reason })
            .then(() => {
                toast('Adisyon iptal edildi.');
                $('posOverlay').classList.remove('open'); currentCheck = null;
            })
            .catch(err => {
                console.error(err);
                if (isFnMissing(err)) { toast('İptal servisi henüz yüklenmemiş (deploy eksik) — yöneticinizle iletişime geçin.', true); return; }
                const det = (err && err.details) || {};
                if (det.errCode === 'REST/ROLE_DENIED') { toast('Gönderilmiş adisyonu yalnızca yönetici iptal edebilir — yönetici hesabıyla giriş gerekli.', true); return; }
                toast(restErrMsg(err, 'İptal edilemedi'), true);
            });
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
        const psEl = $('posPrintShares'); if (psEl) psEl.style.display = currentCheck.splitGroup ? '' : 'none';
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
        // Gecikmeli saveCheck ile ödeme arasındaki yarışı kapat (Faz 3):
        // bekleyen debounce'lu kayıt varsa ödeme modalı açılmadan yazılır.
        flushSave();
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
            // `inhouse` listesindeki (status==='in_house') güncel doluluğa karşı
            // doğrulanır — aksi halde çıkış yapmış/yanlış yazılmış bir oda
            // numarasına, o odada gerçekten kimse konaklamıyorken ücret
            // yazılabiliyordu. Doğrulama geçmezse personel geçerli misafir
            // listesinden seçim yapan pickRoom() akışına yönlendirilir.
            const occ = currentCheck && currentCheck.room ? inhouse.find(g => String(g.room) === String(currentCheck.room)) : null;
            if (currentCheck && currentCheck.room && occ) {
                pay.payments.push({ method: 'room', amount: amt, room: currentCheck.room, guestName: occ.name || currentCheck.name || '', guestId: occ.id });
                payEntry = ''; renderPay();
            } else {
                if (currentCheck && currentCheck.room) toast('Bu odada şu anda konaklayan misafir görünmüyor — listeden seçin.', true);
                pickRoom(amt);
            }
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
        // %100'ü aşan bir yüzde (yazım hatası, ör. "150" yerine "15") ödenecek
        // tutarı NEGATİFE düşürüp adisyonun hiç ödeme alınmadan kapanmasına
        // izin verirdi (paySettle disabled koşulu payable<=0'ı da kapsıyordu).
        if (type === 'percent' && value > 100) { toast('İndirim yüzdesi 100\'ü aşamaz.', true); value = 100; }
        const reason = prompt('Sebep (opsiyonel):', pay.discount ? (pay.discount.reason || '') : '') || '';
        pay.discount = { type, value, reason: reason.slice(0, 60) };
        renderPay();
    }

    // ÖDEME artık SUNUCUDA (Faz 4 — restSettleCheck): tutarlar sunucuda
    // adisyonun GÜNCEL kalemlerinden hesaplanır; kart/oda fazla ödeme
    // reddedilir; nakit fazlası para üstüdür (ciroya girmez); folio + stok
    // + audit aynı transaction; operationId çift ödemeyi imkânsız kılar.
    // İstemcinin paid yazması kurallarla da kapalı — legacy yol YOK
    // (rules+functions+hosting birlikte deploy edilmeli, plan §5).
    let settleInFlight = false;
    function settle() {
        if (settleInFlight || !currentCheck) return;
        const checkId = currentCheck.id;
        const finish = (data) => {
            const change = (data && data.change) || 0;
            toast(change > 0.005 ? ('Adisyon kapatıldı — para üstü ' + money(change)) : 'Adisyon kapatıldı.');
            closePay();
            $('posOverlay').classList.remove('open');
            currentCheck = null;
        };
        const fail = (err) => {
            console.error(err);
            if (isFnMissing(err)) {
                toast('Ödeme servisi henüz yüklenmemiş (deploy eksik) — yöneticinizle iletişime geçin.', true);
            } else {
                toast(restErrMsg(err, 'Kapatılamadı'), true);
            }
            if (pay) renderPay();
        };
        const callSettle = (id) => {
            const call = firebase.app().functions('us-central1').httpsCallable('restSettleCheck');
            return call({
                operationId: newOperationId(),
                checkId: id,
                payments: pay.payments.map(pm => ({ method: pm.method, amount: pm.amount, room: pm.room || '', guestName: pm.guestName || '', guestId: pm.guestId || '' })),
                discount: pay.discount ? { type: pay.discount.type, value: pay.discount.value, reason: pay.discount.reason || '' } : null
            }).then(res => res.data);
        };

        settleInFlight = true;
        if ($('paySettle')) $('paySettle').disabled = true;
        const chain = !checkId
            ? db.collection(CHK_COL).add({ // adisyon henüz yazılmadıysa (teorik) — önce açık olarak oluştur
                tenantId: TENANT_ID, tableName: currentCheck.tableName || '', tableKey: tableKeyOf(currentCheck.tableName), name: currentCheck.name || '', room: currentCheck.room || '',
                section: currentCheck.section || 'Genel', pax: currentCheck.pax || 1, items: currentCheck.items, status: 'open', version: 1,
                openedBy: loggedUser, openedAt: firebase.firestore.FieldValue.serverTimestamp()
            }).then(ref => { currentCheck.id = ref.id; return callSettle(ref.id); })
            : callSettle(checkId);
        chain.then(finish).catch(fail).finally(() => { settleInFlight = false; });
    }

    // ── Fiş (80mm termal) ──────────────────────────────────────
    function fmtTime(ts) {
        const d = tsToDate(ts); if (!d) return '';
        const p = n => n < 10 ? '0' + n : '' + n;
        return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function splitName(n) {
        const s = String(n || '').trim();
        if (!s) return { first: '', last: '' };
        const parts = s.split(/\s+/);
        if (parts.length === 1) return { first: parts[0], last: '' };
        return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
    }
    function receiptRows(items) {
        return (items || []).map(l => {
            const lt = money(l.ikram ? 0 : round2((l.unitPrice || 0) * l.qty));
            return `<tr><td>${esc(l.qty)}×</td><td>${esc(l.name)}${l.ikram ? ' (İkram)' : ''}</td><td class="r">${esc(lt)}</td></tr>`
                + (l.note ? `<tr><td></td><td colspan="2" class="note">» ${esc(l.note)}</td></tr>` : '');
        }).join('');
    }
    // Tek fiş çıktısı (canlı ödeme + arşiv yeniden yazdırma için ortak).
    function receiptStyle() {
        return `@page{size:80mm auto;margin:0}
 *{box-sizing:border-box}
 body{width:80mm;margin:0;padding:0;font-family:'Courier New',monospace;font-size:12px;color:#000}
 .rcpt{padding:8px 10px}
 .rcpt + .rcpt{page-break-before:always;border-top:2px dashed #999}
 .r{text-align:right}
 h1{font-size:15px;margin:0 0 2px;text-align:center}
 .sub{text-align:center;font-size:11px;margin-bottom:3px}
 hr{border:none;border-top:1px dashed #000;margin:6px 0}
 table{width:100%;border-collapse:collapse}
 td{padding:1px 0;vertical-align:top;font-size:12px}
 .note{font-size:10px;color:#333}
 .tot .big{font-size:15px;font-weight:bold}
 .sig{margin-top:4px}
 .sig td{font-size:12px;padding:5px 0}
 .sig td:first-child{width:62px;color:#000}
 .ft{text-align:center;font-size:11px;margin-top:8px}`;
    }
    function receiptInner(c) {
        const pays = (c.payments || []).map(pm => `<tr><td colspan="2">${esc(PM_LABEL[pm.method] || pm.method)}${pm.room ? ' (Oda ' + esc(pm.room) + ')' : ''}</td><td class="r">${esc(money(pm.amount))}</td></tr>`).join('');
        return `<div class="rcpt">
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
<hr>
<table class="sig">
 <tr><td>İsim</td><td>: ${esc(splitName(c.name).first)}</td></tr>
 <tr><td>Soyisim</td><td>: ${esc(splitName(c.name).last)}</td></tr>
 <tr><td>Oda No</td><td>: ${esc(c.room || '')}</td></tr>
 <tr><td>İmza</td><td>: ____________________</td></tr>
</table>
<div class="ft">${esc(cfg.receiptFooter || 'Bizi tercih ettiğiniz için teşekkürler.')}</div>
</div>`;
    }
    // Tek pencerede bir veya birden çok fiş (her biri ayrı sayfa/kesim).
    function printReceiptList(list) {
        list = (list || []).filter(Boolean);
        if (!list.length) { toast('Yazdırılacak fiş yok.', true); return; }
        const w = window.open('', '_blank', 'width=380,height=640');
        if (!w) { toast('Açılır pencere engellendi.', true); return; }
        w.document.write(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Fiş</title>
<style>${receiptStyle()}</style></head><body>${list.map(receiptInner).join('')}
<scr` + `ipt>window.onload=function(){setTimeout(function(){window.print();},250);}</scr` + `ipt>
</body></html>`);
        w.document.close();
    }
    function printReceiptDoc(c) { printReceiptList([c]); }
    // Kayıtlı bir adisyondan fiş-yazdırma nesnesi (çoklu fiş için).
    function receiptObjFromCheck(c) {
        const t = computeTotals(c.items || []);
        return { checkNo: c.checkNo, tableName: c.tableName, room: c.room, name: c.name, pax: c.pax || 1, by: loggedUser, items: c.items || [], note: c.note, subtotal: t.subtotal, vat: t.vat, payable: t.total, discountAmount: 0, payments: [] };
    }
    function printReceipt() {
        const p = payable();
        printReceiptDoc({
            checkNo: currentCheck.checkNo, tableName: currentCheck.tableName, room: currentCheck.room, name: currentCheck.name, pax: currentCheck.pax,
            by: loggedUser, items: currentCheck.items, note: currentCheck.note, subtotal: p.gross.subtotal, vat: p.gross.vat, payable: p.payable,
            discountAmount: discountAmount(p.gross.total), payments: (pay && pay.payments) || []
        });
    }
    function printStored(check) {
        printReceiptDoc({
            checkNo: check.checkNo, tableName: check.tableName, room: check.room, name: check.name, pax: check.pax, note: check.note,
            by: check.closedBy || check.openedBy, when: fmtTime(check.closedAt),
            items: check.items, subtotal: check.subtotal || 0, vat: check.vat || 0,
            payable: (check.payable != null ? check.payable : check.total) || 0,
            discountAmount: (check.discount && check.discount.amount) || 0, payments: check.payments || []
        });
    }

    // ── Folio (Oda Hesapları) ──────────────────────────────────
    // Durum filtreleri SUNUCUDA — önceden tüm dizin/tüm folio tarihçesi
    // canlı dinlenip istemcide filtreleniyordu (bkz. hız denetimi).
    function listenInhouse() {
        db.collection('guestDirectory').where('tenantId', '==', TENANT_ID)
            .where('status', '==', 'in_house').onSnapshot(snap => {
                inhouse = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
            }, err => console.error('inhouse', err));
    }
    function listenFolio() {
        db.collection(FOLIO_COL).where('tenantId', '==', TENANT_ID)
            .where('status', '==', 'open').onSnapshot(snap => {
                folio = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
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
    // Oda hesabı kapatma artık SUNUCUDA (Faz 4 — restSettleFolio):
    // manager/admin ister, audit'e yazılır, idempotent. İstemcinin
    // folioCharges güncellemesi kurallarla kapalı.
    function settleFolio(key) {
        const arr = folio.filter(f => ((f.room || '—') + '|' + (f.guestName || '')) === key);
        if (!arr.length) return;
        const tot = round2(arr.reduce((s, f) => s + (Number(f.amount) || 0), 0));
        if (!confirm('Oda ' + (arr[0].room || '—') + ' hesabı (' + money(tot) + ') tahsil edilip kapatılsın mı?')) return;
        const call = firebase.app().functions('us-central1').httpsCallable('restSettleFolio');
        call({ operationId: newOperationId(), chargeIds: arr.map(f => f.id) })
            .then(() => toast('Oda hesabı kapatıldı.'))
            .catch(err => {
                console.error(err);
                if (isFnMissing(err)) { toast('Servis henüz yüklenmemiş (deploy eksik) — yöneticinizle iletişime geçin.', true); return; }
                const det = (err && err.details) || {};
                if (det.errCode === 'REST/ROLE_DENIED') { toast('Oda hesabını yalnızca yönetici kapatabilir.', true); return; }
                toast(restErrMsg(err, 'İşlem başarısız'), true);
            });
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

    // ── Gün Sonu / Z-Raporu ────────────────────────────────────
    let zData = null;
    function loadZ() {
        const day = ($('zDate') && $('zDate').value) || todayYmd();
        const p = day.split('-');
        const s = new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0);
        const e = new Date(+p[0], +p[1] - 1, +p[2], 23, 59, 59, 999);
        if ($('zBody')) $('zBody').innerHTML = `<div class="rst-empty">Yükleniyor…</div>`;
        const mapDocs = snap => snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
        const paidQ = db.collection(CHK_COL).where('tenantId', '==', TENANT_ID).where('closedAt', '>=', s).where('closedAt', '<=', e).get()
            .then(snap => mapDocs(snap).filter(c => c.status === 'paid'))
            .catch(() => db.collection(CHK_COL).where('tenantId', '==', TENANT_ID).get()
                .then(snap => mapDocs(snap).filter(c => { const dt = tsToDate(c.closedAt); return c.status === 'paid' && dt && dt >= s && dt <= e; })));
        const voidQ = db.collection(CHK_COL).where('tenantId', '==', TENANT_ID).where('status', '==', 'void').get()
            .then(snap => mapDocs(snap).filter(c => { const dt = tsToDate(c.updatedAt) || tsToDate(c.closedAt); return dt && dt >= s && dt <= e; }))
            .catch(() => []);
        Promise.all([paidQ, voidQ]).then(([paid, voids]) => { zData = computeZ(paid, voids, day); renderZ(); })
            .catch(err => { console.error(err); if ($('zBody')) $('zBody').innerHTML = `<div class="rst-empty">Yüklenemedi.</div>`; });
    }
    function computeZ(paid, voids, day) {
        const z = { day: day, checks: paid.length, pax: 0, gross: 0, subtotal: 0, vat: 0, discount: 0, ikramValue: 0, ikramCount: 0, pay: { cash: 0, card: 0, room: 0 }, payCount: { cash: 0, card: 0, room: 0 }, staff: {}, voids: voids.length, voidValue: 0 };
        paid.forEach(c => {
            z.pax += Number(c.pax) || 0;
            z.gross += checkTotal(c);
            z.subtotal += Number(c.subtotal) || 0;
            z.vat += Number(c.vat) || 0;
            z.discount += (c.discount && c.discount.amount) || 0;
            (c.items || []).forEach(l => { if (l.ikram) { z.ikramValue += round2((l.unitPrice || 0) * (l.qty || 1)); z.ikramCount += 1; } });
            (c.payments || []).forEach(pm => { const m = pm.method || 'cash'; if (z.pay[m] == null) { z.pay[m] = 0; z.payCount[m] = 0; } z.pay[m] += Number(pm.amount) || 0; z.payCount[m] += 1; });
            const who = c.closedBy || c.openedBy || '—';
            if (!z.staff[who]) z.staff[who] = { count: 0, revenue: 0 };
            z.staff[who].count += 1; z.staff[who].revenue += checkTotal(c);
        });
        voids.forEach(c => { z.voidValue += Number(c.total) || 0; });
        z.gross = round2(z.gross); z.subtotal = round2(z.subtotal); z.vat = round2(z.vat); z.discount = round2(z.discount); z.ikramValue = round2(z.ikramValue); z.voidValue = round2(z.voidValue);
        Object.keys(z.pay).forEach(m => z.pay[m] = round2(z.pay[m]));
        return z;
    }
    function zPayTotal(z) { return round2(Object.keys(z.pay).reduce((s, m) => s + z.pay[m], 0)); }
    function zStaffSorted(z) { return Object.keys(z.staff).sort((a, b) => z.staff[b].revenue - z.staff[a].revenue); }
    function renderZ() {
        const z = zData; if (!z) return;
        if ($('zKpis')) $('zKpis').innerHTML = [['Net Ciro', money(z.gross)], ['Adisyon', z.checks], ['Kişi', z.pax], ['Ort. Adisyon', money(z.checks ? z.gross / z.checks : 0)]]
            .map(([l, v]) => `<div class="rst-kpi"><span class="v">${esc(v)}</span><span class="l">${esc(l)}</span></div>`).join('');
        const body = $('zBody'); if (!body) return;
        if (!z.checks && !z.voids) { body.innerHTML = `<div class="rst-empty">Bu gün için kapanmış adisyon yok.</div>`; return; }
        const extra = Object.keys(z.pay).filter(m => ['cash', 'card', 'room'].indexOf(m) === -1);
        const payRow = (label, amt, cnt) => `<div class="rst-z-row"><span>${esc(label)}</span><span class="rst-z-cnt">${cnt} ödeme</span><b>${esc(money(amt))}</b></div>`;
        body.innerHTML = `
          <div class="rst-z-grid">
            <div class="rst-z-card">
              <h3>Ödeme Dağılımı</h3>
              ${payRow('Nakit', z.pay.cash, z.payCount.cash)}
              ${payRow('Kart', z.pay.card, z.payCount.card)}
              ${payRow('Oda Hesabı', z.pay.room, z.payCount.room)}
              ${extra.map(m => payRow(PM_LABEL[m] || m, z.pay[m], z.payCount[m])).join('')}
              <div class="rst-z-row total"><span>Toplam Tahsilat</span><span></span><b>${esc(money(zPayTotal(z)))}</b></div>
            </div>
            <div class="rst-z-card">
              <h3>Özet</h3>
              <div class="rst-z-row"><span>Ara Toplam</span><span></span><b>${esc(money(z.subtotal))}</b></div>
              <div class="rst-z-row"><span>KDV</span><span></span><b>${esc(money(z.vat))}</b></div>
              <div class="rst-z-row"><span>İndirim</span><span></span><b>${z.discount ? '-' : ''}${esc(money(z.discount))}</b></div>
              <div class="rst-z-row"><span>İkram</span><span class="rst-z-cnt">${z.ikramCount} kalem</span><b>${z.ikramValue ? '-' : ''}${esc(money(z.ikramValue))}</b></div>
              <div class="rst-z-row"><span>İptal (void)</span><span class="rst-z-cnt">${z.voids} adisyon</span><b>${esc(money(z.voidValue))}</b></div>
              <div class="rst-z-row total"><span>Net Ciro</span><span></span><b>${esc(money(z.gross))}</b></div>
            </div>
          </div>
          <div class="rst-z-card">
            <h3>Personel Bazında Ciro</h3>
            <div class="rst-z-staff-h"><span>Personel</span><span class="c">Adisyon</span><span class="r">Ciro</span></div>
            ${zStaffSorted(z).map(w => `<div class="rst-z-staff"><span>${esc(w)}</span><span class="c">${z.staff[w].count}</span><span class="r">${esc(money(round2(z.staff[w].revenue)))}</span></div>`).join('') || '<div class="rst-z-staff"><span>—</span><span class="c">0</span><span class="r">—</span></div>'}
          </div>`;
    }
    function printZ() {
        if (!zData || (!zData.checks && !zData.voids)) { toast('Bu gün için veri yok.', true); return; }
        const z = zData;
        const w = window.open('', '_blank', 'width=380,height=680');
        if (!w) { toast('Açılır pencere engellendi.', true); return; }
        const dp = z.day.split('-'); const dayTr = dp.length === 3 ? dp[2] + '.' + dp[1] + '.' + dp[0] : z.day;
        const row = (l, v, sub) => `<tr><td>${esc(l)}${sub ? ' <small>(' + esc(sub) + ')</small>' : ''}</td><td class="r">${esc(v)}</td></tr>`;
        const extra = Object.keys(z.pay).filter(m => ['cash', 'card', 'room'].indexOf(m) === -1);
        const staff = zStaffSorted(z).map(wn => row(wn, money(round2(z.staff[wn].revenue)), z.staff[wn].count + ' adisyon')).join('');
        w.document.write(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Z Raporu</title>
<style>
 @page{size:80mm auto;margin:0}*{box-sizing:border-box}
 body{width:80mm;margin:0;padding:8px 10px;font-family:'Courier New',monospace;font-size:12px;color:#000}
 h1{font-size:15px;margin:0 0 2px;text-align:center}
 .sub{text-align:center;font-size:11px;margin-bottom:3px}
 hr{border:none;border-top:1px dashed #000;margin:6px 0}
 table{width:100%;border-collapse:collapse}
 td{padding:2px 0;font-size:12px;vertical-align:top}.r{text-align:right}
 .sec{font-weight:bold;font-size:11px;margin:6px 0 2px;text-transform:uppercase;letter-spacing:.5px}
 .big td{font-size:14px;font-weight:bold}
 small{font-size:10px;color:#333}
</style></head><body>
<h1>${esc(cfg.receiptHeader || cfg.name || 'Restoran')}</h1>
<div class="sub">GÜN SONU / Z-RAPORU</div>
<div class="sub">${esc(dayTr)} · ${esc(loggedUser)}</div>
<hr>
<div class="sec">Ödeme Dağılımı</div>
<table>
${row('Nakit', money(z.pay.cash))}
${row('Kart', money(z.pay.card))}
${row('Oda Hesabı', money(z.pay.room))}
${extra.map(m => row(PM_LABEL[m] || m, money(z.pay[m]))).join('')}
<tr class="big"><td>Toplam Tahsilat</td><td class="r">${esc(money(zPayTotal(z)))}</td></tr>
</table>
<hr>
<div class="sec">Özet</div>
<table>
${row('Adisyon', z.checks)}
${row('Kişi', z.pax)}
${row('Ara Toplam', money(z.subtotal))}
${row('KDV', money(z.vat))}
${row('İndirim', '-' + money(z.discount))}
${row('İkram', '-' + money(z.ikramValue), z.ikramCount + ' kalem')}
${row('İptal (void)', money(z.voidValue), z.voids + ' adisyon')}
<tr class="big"><td>NET CİRO</td><td class="r">${esc(money(z.gross))}</td></tr>
</table>
<hr>
<div class="sec">Personel Bazında</div>
<table>${staff || row('—', '—')}</table>
<div class="sub" style="margin-top:8px">Bu rapor bilgilendirme amaçlıdır.</div>
<scr` + `ipt>window.onload=function(){setTimeout(function(){window.print();},250);}</scr` + `ipt>
</body></html>`);
        w.document.close();
    }

    function wireFloorPos() {
        $('newCheckBtn').onclick = () => openCheckModal(null);
        const fsr = $('floorSearch'); if (fsr) fsr.oninput = e => { floorSearch = e.target.value; renderFloor(); };
        $('checkModalClose').onclick = closeCheckModal;
        $('checkForm').onsubmit = submitCheck;
        $('ckRoom').oninput = onRoomInput;
        $('arcDate').onchange = loadArchive;
        if ($('zDate')) $('zDate').onchange = loadZ;
        if ($('zPrint')) $('zPrint').onclick = printZ;
        $('arcClose').onclick = () => $('arcModal').classList.remove('open');
        $('arcModal').addEventListener('click', e => { if (e.target === $('arcModal')) $('arcModal').classList.remove('open'); });
        $('checkModal').addEventListener('click', e => { if (e.target === $('checkModal')) closeCheckModal(); });
        $('posBack').onclick = closePos;
        const sw = $('posSwitch');
        if (sw) sw.addEventListener('click', e => { const t = e.target.closest('.rst-ps-tab'); if (t) setPosPane(t.getAttribute('data-pane')); });
        $('posVoid').onclick = voidCheck;
        $('posSend').onclick = sendKitchen;
        $('posServe').onclick = serveAll;
        $('posPay').onclick = () => { flushSave(); openPay(); };
        $('posNote').onclick = () => openNoteModal('check');
        $('posSplit').onclick = openSplit;
        $('posMerge').onclick = openMerge;
        $('posTransfer').onclick = openTransfer;
        if ($('posPrintShares')) $('posPrintShares').onclick = printSplitGroup;
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
        if ($('splitEqConfirm')) $('splitEqConfirm').onclick = doSplitEqual;
        document.querySelectorAll('.rst-split-tab').forEach(t => t.onclick = () => setSplitMode(t.getAttribute('data-smode')));
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
        applyRoleTabs();
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
            if ($('zDate')) $('zDate').value = todayYmd();
        };
        if (typeof auth !== 'undefined' && auth.onAuthStateChanged) auth.onAuthStateChanged(u => { if (u) go(); });
        else go();
        // Salon kartlarındaki süre/uyarı renklerini canlı tut (yeniden render olmadan)
        setInterval(tickFloor, 30000);
    }
    function tickFloor() {
        if ($('posOverlay') && $('posOverlay').classList.contains('open')) return;
        const fv = $('view-floor'); if (!fv || !fv.classList.contains('active')) return;
        renderFloor();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
