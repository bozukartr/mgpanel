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
    function rowHtml(i) {
        const active = i.active !== false;
        const vat = (i.vatRate != null && i.vatRate !== '') ? i.vatRate + '% KDV' : '';
        const sub = [STATION[i.station] || 'Mutfak', vat].filter(Boolean).join(' · ');
        return `<div class="rst-item ${active ? '' : 'off'}" data-edit="${esc(i.id)}">
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

    // ════════════════════════════════════════════════════════════
    //  SALON (masalar) + POS (sipariş / adisyon)
    // ════════════════════════════════════════════════════════════
    const CHK_COL = 'restChecks';
    let openChecks = [];        // status 'open'|'sent' (açık adisyonlar)
    let editingCheckId = null;  // checkModal düzenleme hedefi (null = yeni)
    let currentCheck = null;    // POS'ta düzenlenen adisyon
    let posCat = '';
    let posSearch = '';
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
            const line = (Number(it.unitPrice) || 0) * (it.qty || 1);
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
    function elapsed(c) {
        const t = tsToDate(c.openedAt); if (!t) return '';
        const m = Math.floor((Date.now() - t.getTime()) / 60000);
        if (m < 1) return 'az önce';
        if (m < 60) return m + ' dk';
        return Math.floor(m / 60) + ' sa ' + (m % 60) + ' dk';
    }

    function renderKpis() {
        const k = $('floorKpis'); if (!k) return;
        const occ = openChecks.length;
        const pax = openChecks.reduce((s, c) => s + (Number(c.pax) || 0), 0);
        const sent = openChecks.filter(c => c.status === 'sent').length;
        const openTotal = round2(openChecks.reduce((s, c) => s + (Number(c.total) || 0), 0));
        const cards = [['Açık Adisyon', occ], ['Toplam Kişi', pax], ['Mutfakta', sent], ['Açık Tutar', money(openTotal)]];
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
    function checkCardHtml(c) {
        const sent = c.status === 'sent';
        return `<button class="rst-table ${sent ? 'sent' : 'busy'}" data-chk="${esc(c.id)}">
            <span class="rst-table-n">${esc(c.tableName || '—')}</span>
            ${(c.room || c.name) ? `<span class="rst-table-name">${esc(c.room ? 'Oda ' + c.room : '')}${(c.room && c.name) ? ' · ' : ''}${esc(c.name || '')}</span>` : ''}
            <span class="rst-table-s">${esc(money(c.total || 0))} · ${esc(c.pax || 1)} kişi</span>
            <span class="rst-table-foot">${sent ? 'Mutfakta' : 'Açık'} · ${esc(elapsed(c))}</span>
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
            db.collection(CHK_COL).add(Object.assign({
                tenantId: TENANT_ID, status: 'open', items: [], subtotal: 0, vat: 0, total: 0, openedBy: loggedUser, openedAt: TS
            }, data)).then(ref => {
                closeCheckModal();
                openPos({ id: ref.id, tableName: data.tableName, pax: data.pax, room: data.room, name: data.name, section: data.section, status: 'open', items: [] });
            }).catch(err => { console.error(err); toast('Açılamadı.', true); });
        }
    }

    function listenChecks() {
        db.collection(CHK_COL).where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            openChecks = snap.docs.map(d => Object.assign({ id: d.id }, d.data()))
                .filter(c => c.status === 'open' || c.status === 'sent');
            renderFloor();
        }, err => console.error('checks', err));
    }

    // ── POS ────────────────────────────────────────────────────
    function setPosHeader() {
        $('posTable').textContent = 'Masa ' + (currentCheck.tableName || '');
        $('posMeta').textContent = (currentCheck.room ? 'Oda ' + currentCheck.room + ' · ' : '') + (currentCheck.name ? currentCheck.name + ' · ' : '') + (currentCheck.pax || 1) + ' kişi';
        $('posPax').textContent = currentCheck.pax || 1;
    }
    function openPos(check) {
        currentCheck = JSON.parse(JSON.stringify(check));
        if (!currentCheck.items) currentCheck.items = [];
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
            ? items.map(i => `<button class="rst-pitem" data-mi="${esc(i.id)}">
                <span class="pi-n">${esc(i.name)}</span>
                <span class="pi-p">${esc(money(i.price))}</span>
            </button>`).join('')
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
        currentCheck.items.push({
            lineId: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
            menuId: null, name: name.slice(0, 60), category: 'Açık Ürün',
            unitPrice: price, qty: 1, vatRate: null, station: 'kitchen', note: '', sent: false
        });
        recalcSave();
    }

    function addLine(mi) {
        const ex = currentCheck.items.find(l => l.menuId === mi.id && !l.sent && !(l.note));
        if (ex) ex.qty++;
        else currentCheck.items.push({
            lineId: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
            menuId: mi.id, name: mi.name, category: mi.category || 'Diğer',
            unitPrice: Number(mi.price) || 0, qty: 1,
            vatRate: (mi.vatRate != null ? mi.vatRate : null), station: mi.station || 'kitchen', note: '', sent: false
        });
        recalcSave();
    }
    function changeQty(lineId, d) {
        const l = currentCheck.items.find(x => x.lineId === lineId); if (!l) return;
        l.qty += d; if (l.qty <= 0) currentCheck.items = currentCheck.items.filter(x => x.lineId !== lineId);
        recalcSave();
    }
    function removeLine(lineId) { currentCheck.items = currentCheck.items.filter(x => x.lineId !== lineId); recalcSave(); }
    function noteLine(lineId) {
        const l = currentCheck.items.find(x => x.lineId === lineId); if (!l) return;
        const n = prompt('Not (örn. az pişmiş, sossuz):', l.note || '');
        if (n !== null) { l.note = String(n).slice(0, 80); recalcSave(); }
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
            section: currentCheck.section || 'Genel', status: currentCheck.status || 'open', pax: currentCheck.pax || 1,
            items: currentCheck.items, subtotal: currentCheck.subtotal || 0, vat: currentCheck.vat || 0, total: currentCheck.total || 0,
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
        const t = computeTotals(currentCheck.items);
        currentCheck.subtotal = t.subtotal; currentCheck.vat = t.vat; currentCheck.total = t.total;
        renderPosCheck(); flushSave();
        toast(fresh ? fresh + ' kalem mutfağa gönderildi.' : 'Mutfağa gönderildi.');
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

    function renderPosCheck() {
        const lines = $('posLines');
        if (!currentCheck.items.length) {
            lines.innerHTML = `<div class="rst-check-empty">Soldan ürün ekleyin.</div>`;
        } else {
            lines.innerHTML = currentCheck.items.map(l => `<div class="rst-line ${l.sent ? 'sent' : ''}">
                <div class="rst-line-main">
                    <div class="rst-line-n">${esc(l.name)}${l.sent ? ' <span class="rst-line-snt">✓</span>' : ''}</div>
                    ${l.note ? `<div class="rst-line-note">“${esc(l.note)}”</div>` : ''}
                </div>
                <div class="rst-line-qty">
                    <button data-q="-" data-l="${esc(l.lineId)}">−</button>
                    <span>${l.qty}</span>
                    <button data-q="+" data-l="${esc(l.lineId)}">+</button>
                </div>
                <div class="rst-line-tot">${esc(money(round2((l.unitPrice || 0) * l.qty)))}</div>
                <div class="rst-line-acts">
                    <button data-note="${esc(l.lineId)}" title="Not">Not</button>
                    <button data-del="${esc(l.lineId)}" title="Kaldır">✕</button>
                </div>
            </div>`).join('');
            lines.querySelectorAll('[data-q]').forEach(b => b.onclick = () => changeQty(b.getAttribute('data-l'), b.getAttribute('data-q') === '+' ? 1 : -1));
            lines.querySelectorAll('[data-note]').forEach(b => b.onclick = () => noteLine(b.getAttribute('data-note')));
            lines.querySelectorAll('[data-del]').forEach(b => b.onclick = () => removeLine(b.getAttribute('data-del')));
        }
        const t = computeTotals(currentCheck.items);
        const vatLabel = (cfg.vatMode === 'excluded') ? 'KDV (hariç)' : 'KDV (dahil)';
        $('posTotals').innerHTML = `
            <div class="rst-tot-row"><span>Ara Toplam</span><b>${esc(money(t.subtotal))}</b></div>
            <div class="rst-tot-row"><span>${vatLabel}</span><b>${esc(money(t.vat))}</b></div>
            <div class="rst-tot-row big"><span>Toplam</span><b>${esc(money(t.total))}</b></div>`;
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
    function printReceipt() {
        const p = payable();
        const dA = discountAmount(p.gross.total);
        const rows = currentCheck.items.map(l => {
            const lt = money(round2((l.unitPrice || 0) * l.qty));
            return `<tr><td>${esc(l.qty)}×</td><td>${esc(l.name)}</td><td class="r">${esc(lt)}</td></tr>`
                + (l.note ? `<tr><td></td><td colspan="2" class="note">» ${esc(l.note)}</td></tr>` : '');
        }).join('');
        const pays = (pay && pay.payments || []).map(pm => `<tr><td colspan="2">${esc(PM_LABEL[pm.method] || pm.method)}${pm.room ? ' (Oda ' + esc(pm.room) + ')' : ''}</td><td class="r">${esc(money(pm.amount))}</td></tr>`).join('');
        const w = window.open('', '_blank', 'width=380,height=640');
        if (!w) { toast('Açılır pencere engellendi.', true); return; }
        w.document.write(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Fiş</title>
<style>
 @page{size:80mm auto;margin:0}
 *{box-sizing:border-box}
 body{width:80mm;margin:0;padding:8px 10px;font-family:'Courier New',monospace;font-size:12px;color:#000}
 .c{text-align:center}.r{text-align:right}.b{font-weight:bold}
 h1{font-size:15px;margin:0 0 2px;text-align:center}
 .sub{text-align:center;font-size:11px;margin-bottom:6px}
 hr{border:none;border-top:1px dashed #000;margin:6px 0}
 table{width:100%;border-collapse:collapse}
 td{padding:1px 0;vertical-align:top;font-size:12px}
 .note{font-size:10px;color:#333}
 .tot td{font-size:12px}.tot .big{font-size:15px;font-weight:bold}
 .ft{text-align:center;font-size:11px;margin-top:8px}
</style></head><body>
<h1>${esc(cfg.receiptHeader || cfg.name || 'Restoran')}</h1>
<div class="sub">Masa ${esc(currentCheck.tableName || '')} · ${esc(currentCheck.pax || 1)} kişi · ${esc(loggedUser)}</div>
<hr>
<table>${rows}</table>
<hr>
<table class="tot">
 <tr><td colspan="2">Ara Toplam</td><td class="r">${esc(money(p.gross.subtotal))}</td></tr>
 <tr><td colspan="2">KDV</td><td class="r">${esc(money(p.gross.vat))}</td></tr>
 ${dA ? `<tr><td colspan="2">İndirim</td><td class="r">-${esc(money(dA))}</td></tr>` : ''}
 <tr class="big"><td colspan="2">TOPLAM</td><td class="r">${esc(money(p.payable))}</td></tr>
</table>
${pays ? '<hr><table>' + pays + '</table>' : ''}
<div class="ft">${esc(cfg.receiptFooter || 'Bizi tercih ettiğiniz için teşekkürler.')}</div>
<scr` + `ipt>window.onload=function(){setTimeout(function(){window.print();},250);}</scr` + `ipt>
</body></html>`);
        w.document.close();
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

    function wireFloorPos() {
        $('newCheckBtn').onclick = () => openCheckModal(null);
        $('checkModalClose').onclick = closeCheckModal;
        $('checkForm').onsubmit = submitCheck;
        $('ckRoom').oninput = onRoomInput;
        $('checkModal').addEventListener('click', e => { if (e.target === $('checkModal')) closeCheckModal(); });
        $('posBack').onclick = closePos;
        $('posVoid').onclick = voidCheck;
        $('posSend').onclick = sendKitchen;
        $('posPay').onclick = () => { flushSave(); openPay(); };
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
        $('menuDeleteBtn').onclick = removeMenu;
        $('menuModal').addEventListener('click', e => { if (e.target === $('menuModal')) closeModal(); });
        wireFloorPos();
        const go = () => { loadConfig(); listenMenu(); listenChecks(); listenInhouse(); listenFolio(); };
        if (typeof auth !== 'undefined' && auth.onAuthStateChanged) auth.onAuthStateChanged(u => { if (u) go(); });
        else go();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
