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
    let editingOptions = []; // katalog modalı açıkken düzenlenen "Seçenekler" taslağı
    let editingModifiers = []; // katalog modalı açıkken düzenlenen "Özelleştirme" taslağı (çıkar/ekstra)
    let unsub = null;
    let cfg = { hotelName: '', showPrices: false, currency: '₺' };

    // Default starter menu — 4 operational categories.
    const DEFAULTS = [
        { category: 'Temizlik', name: 'Oda Temizliği', icon: '🧹', eta: '30-45 dk', maxQty: 1, department: 'Kat Hizmetleri', availFrom: '09:00', availTo: '16:00' },
        { category: 'Temizlik', name: 'Havlu Değişimi', icon: '🧺', eta: '15-30 dk', department: 'Kat Hizmetleri' },
        { category: 'Temizlik', name: 'Çarşaf Değişimi', icon: '🛏️', eta: '30-45 dk', maxQty: 1, department: 'Kat Hizmetleri', availFrom: '09:00', availTo: '16:00' },
        { category: 'Temizlik', name: 'Çöp Toplama', icon: '🗑️', eta: '15 dk', department: 'Kat Hizmetleri' },
        { category: 'Temizlik', name: 'Banyo Malzemeleri', icon: '🧴', eta: '15 dk', department: 'Kat Hizmetleri' },
        { category: 'Konfor', name: 'Ekstra Yastık', icon: '🛏️', eta: '15 dk', department: 'Kat Hizmetleri' },
        { category: 'Konfor', name: 'Ekstra Battaniye', icon: '🧣', eta: '15 dk', department: 'Kat Hizmetleri' },
        { category: 'Konfor', name: 'Terlik', icon: '🥿', eta: '15 dk', department: 'Kat Hizmetleri' },
        { category: 'Konfor', name: 'Bornoz', icon: '🥼', eta: '15 dk', department: 'Kat Hizmetleri' },
        { category: 'Konfor', name: 'Askı', icon: '🧥', eta: '15 dk', department: 'Kat Hizmetleri' },
        { category: 'Yiyecek & İçecek', name: 'Su', icon: '💧', eta: '15 dk', department: 'Yiyecek & İçecek' },
        { category: 'Yiyecek & İçecek', name: 'Çay / Kahve', icon: '☕', eta: '15-20 dk', price: 60, department: 'Yiyecek & İçecek' },
        { category: 'Yiyecek & İçecek', name: 'Meyve Tabağı', icon: '🍎', eta: '20-30 dk', price: 120, department: 'Yiyecek & İçecek' },
        { category: 'Yiyecek & İçecek', name: 'Atıştırmalık', icon: '🍫', eta: '20 dk', price: 80, department: 'Yiyecek & İçecek' },
        { category: 'Yiyecek & İçecek', name: 'Meşrubat', icon: '🥤', eta: '20 dk', price: 70, department: 'Yiyecek & İçecek' },
        { category: 'Yiyecek & İçecek', name: 'Buz', icon: '🧊', eta: '15 dk', department: 'Yiyecek & İçecek' },
        { category: 'Teknik', name: 'Klima Sorunu', icon: '❄️', eta: '30 dk', department: 'Teknik' },
        { category: 'Teknik', name: 'TV Sorunu', icon: '📺', eta: '30 dk', department: 'Teknik' },
        { category: 'Teknik', name: 'Sıcak Su Yok', icon: '🚿', eta: '30 dk', department: 'Teknik' },
        { category: 'Teknik', name: 'Wi-Fi Sorunu', icon: '📶', eta: '20 dk', department: 'Teknik' },
        { category: 'Teknik', name: 'Ampul Değişimi', icon: '💡', eta: '20 dk', department: 'Teknik' }
    ];

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const $ = id => document.getElementById(id);
    const toast = window.showToast; // js/utils/toast.js (paylaşımlı)

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
        .cat-row .cat-flag.opt { background: #eef2ff; color: #4f46e5; }
        .cat-opt-chip { display: inline-flex; align-items: center; gap: 6px; background: #eef2ff; color: #4338ca;
            border: 1px solid #c7d2fe; font-size: 12.5px; font-weight: 600; padding: 5px 8px 5px 12px; border-radius: 999px; }
        .cat-opt-chip button { background: none; border: none; color: #6366f1; font-size: 14px; line-height: 1;
            cursor: pointer; padding: 2px; font-family: inherit; }
        .cat-opt-empty { font-size: 12px; color: #94a3b8; }
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
        .qr-card .qr-dl { margin-top: 5px; font-size: 12px; color: #2563eb; cursor: pointer; background: none; border: none; font-weight: 600; font-family: inherit; }
        .cat-bulk-row { display: grid; grid-template-columns: 150px 1fr 1fr 100px 32px; gap: 8px; align-items: center; margin-bottom: 8px; }
        .cat-bulk-row.cat-bulk-head { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .4px; color: #94a3b8; margin-bottom: 6px; }
        .cat-bulk-row select, .cat-bulk-row input { width: 100%; padding: 9px 10px; border: 1px solid #e2e8f0; border-radius: 8px;
            font-size: 13.5px; font-family: inherit; color: #1e293b; box-sizing: border-box; }
        .cat-bulk-row select:focus, .cat-bulk-row input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.12); }
        .cat-bulk-row-del { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; border-radius: 8px; width: 32px; height: 34px;
            cursor: pointer; font-size: 13px; line-height: 1; font-family: inherit; }
        .cat-bulk-row-del:hover { background: #fee2e2; }`;
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

    // ── Arama (Talepler listesi) ────────────────────────────────
    let searchTerm = '';
    function norm(s) { return String(s || '').trim().toLocaleLowerCase('tr-TR'); }
    function visibleItems() {
        const t = norm(searchTerm);
        if (!t) return items;
        return items.filter(i => norm(i.name).includes(t) || norm(i.category).includes(t) || norm(i.subcategory).includes(t));
    }
    function categoriesIn(list) {
        const seen = [];
        list.slice().sort(byOrder).forEach(i => { const c = i.category || 'Diğer'; if (!seen.includes(c)) seen.push(c); });
        return seen;
    }
    function subcatsIn(list, cat) {
        const seen = [];
        list.filter(i => (i.category || 'Diğer') === cat).slice().sort(byOrder).forEach(i => {
            const s = (i.subcategory || '').trim();
            if (!seen.includes(s)) seen.push(s);
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
        // Category + subcategory datalists for the modal — HER ZAMAN tüm
        // kataloğa göre (arama filtresine göre değil, admin arama kutusuna bir
        // şey yazsa bile modalda tüm kategorileri görebilmeli).
        const dl = $('catCatOptions');
        if (dl) dl.innerHTML = categoriesOrdered().map(c => `<option value="${esc(c)}">`).join('');
        const dls = $('catSubOptions');
        if (dls) dls.innerHTML = allSubcats().map(s => `<option value="${esc(s)}">`).join('');

        if (!items.length) {
            wrap.innerHTML = `<div class="cat-empty">Henüz talep eklenmemiş.<br>“Varsayılanları Yükle” ile başlayabilir veya “Talep Ekle” diyebilirsiniz.</div>`;
            return;
        }
        const list = visibleItems();
        if (!list.length) {
            wrap.innerHTML = `<div class="cat-empty">"${esc(searchTerm.trim())}" ile eşleşen talep yok.</div>`;
            return;
        }
        wrap.innerHTML = categoriesIn(list).map(cat => {
            const catItems = list.filter(i => (i.category || 'Diğer') === cat);
            // Group the category's items by subcategory ('' = ungrouped, shown first).
            const subs = subcatsIn(list, cat);
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
        const optCount = Array.isArray(i.options) ? i.options.length : 0;
        const optTitle = optCount ? i.options.map(normalizeOption).map(o => o.name + (o.priceDelta ? ` (${o.priceDelta > 0 ? '+' : ''}${o.priceDelta}₺)` : '')).join(', ') : '';
        const sub = [i.department || '—', priceTxt, avail].filter(Boolean).join(' · ');
        return `<div class="cat-row ${active ? '' : 'inactive'}" data-edit="${esc(i.id)}">
            <div class="cat-emoji">${esc(i.icon || '🛎️')}</div>
            <div class="cat-body">
                <div class="cat-name">${esc(i.name)}</div>
                <div class="cat-sub">${esc(sub)}</div>
            </div>
            ${optCount ? `<span class="cat-flag opt" title="${esc(optTitle)}">${optCount} seçenek</span>` : ''}
            <span class="cat-flag ${active ? 'on' : 'off'}">${active ? 'Aktif' : 'Pasif'}</span>
        </div>`;
    }

    // ── Departman listesi ──────────────────────────────────────
    // KRİTİK DÜZELTME: departman seçenekleri admin.html'de SABİT bir İngilizce
    // liste olarak gömülüydü (Housekeeping/Front Desk/Engineering/...), oysa
    // personel hesapları otelin KENDİ (Türkçe, özelleştirilebilir) departman
    // listesinden atanıyor (Ayarlar → Departmanlar → IssueConfig). İki liste
    // kesişmediği için bu katalogdan açılan talepleri ilgili departman
    // personeli üstlenemiyordu; otelin eklediği özel departmanlar (Spa,
    // Güvenlik vb.) ise hiç seçilemiyordu. Artık tek kaynak IssueConfig.
    function deptOptions() {
        const list = (window.IssueConfig ? IssueConfig.departments() : []) || [];
        return list.map(d => (d && d.name ? String(d.name) : '')).filter(Boolean);
    }
    // Seçiciyi doldurur; `current` listede olmayan eski bir değerse (ör. eski
    // "Housekeeping" kaydı) kaybolmasın diye ayrıca eklenir.
    function fillDeptSelect(sel, current) {
        if (!sel) return;
        const names = deptOptions();
        const cur = String(current || '');
        if (cur && !names.some(n => n.toLocaleLowerCase('tr-TR') === cur.toLocaleLowerCase('tr-TR'))) names.push(cur);
        sel.innerHTML = ['<option value="">Otomatik (kategoriye göre)</option>']
            .concat(names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`)).join('');
        sel.value = cur;
    }

    // ── Modal ──────────────────────────────────────────────────
    function openModal(id) {
        editingId = id || null;
        const it = id ? items.find(x => x.id === id) : null;
        fillDeptSelect($('catDept'), it ? (it.department || '') : '');
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
        // Geriye dönük uyumluluk: eski kayıtlarda options düz string dizisiydi
        // (priceDelta yoktu) — normalizeOption() ikisini de {name,priceDelta}
        // biçimine indirger, save() her zaman nesne yazar.
        editingOptions = (it && Array.isArray(it.options)) ? it.options.map(normalizeOption) : [];
        if ($('catOptInput')) $('catOptInput').value = '';
        if ($('catOptPriceInput')) $('catOptPriceInput').value = '';
        renderOptChips();
        editingModifiers = (it && Array.isArray(it.modifiers)) ? it.modifiers.map(normalizeModifier) : [];
        if ($('catModInput')) $('catModInput').value = '';
        if ($('catModPriceInput')) $('catModPriceInput').value = '';
        renderModChips();
        $('catalogDeleteBtn').style.display = it ? 'block' : 'none';
        $('catalogModal').style.display = 'flex';
    }
    function closeModal() {
        $('catalogModal').style.display = 'none';
        editingId = null;
        editingOptions = [];
        editingModifiers = [];
    }

    // Eski kayıtlar options: string[] idi (priceDelta yok); yeni kayıtlar
    // options: {name, priceDelta}[]. Bu fonksiyon her iki şekli de tek bir
    // nesne biçimine indirger — admin editörü ve guest-order.js AYNI
    // normalizasyonu kullanır (bkz. guest-order.js normalizeOption).
    function normalizeOption(o) {
        return (o && typeof o === 'object')
            ? { name: String(o.name || '').trim().slice(0, 40), priceDelta: Number(o.priceDelta) || 0 }
            : { name: String(o || '').trim().slice(0, 40), priceDelta: 0 };
    }

    // ── Seçenekler (options) düzenleyici — modal içindeki taslak liste ──
    function renderOptChips() {
        const wrap = $('catOptList'); if (!wrap) return;
        if (!editingOptions.length) { wrap.innerHTML = `<span class="cat-opt-empty">Henüz seçenek eklenmedi.</span>`; return; }
        wrap.innerHTML = editingOptions.map((o, i) => {
            const label = o.name + (o.priceDelta ? ` (${o.priceDelta > 0 ? '+' : ''}${o.priceDelta}₺)` : '');
            return `<span class="cat-opt-chip">${esc(label)}<button type="button" data-optdel="${i}" aria-label="Kaldır">✕</button></span>`;
        }).join('');
        wrap.querySelectorAll('[data-optdel]').forEach(b => b.onclick = () => {
            editingOptions.splice(+b.dataset.optdel, 1);
            renderOptChips();
        });
    }
    function addOption() {
        const inp = $('catOptInput'); if (!inp) return;
        const priceInp = $('catOptPriceInput');
        const val = inp.value.trim().slice(0, 40);
        if (!val) return;
        if (editingOptions.some(o => o.name.toLowerCase() === val.toLowerCase())) { toast('Bu seçenek zaten ekli.', true); inp.value = ''; return; }
        if (editingOptions.length >= 10) { toast('En fazla 10 seçenek ekleyebilirsiniz.', true); return; }
        const priceDelta = priceInp ? (Number(priceInp.value) || 0) : 0;
        editingOptions.push({ name: val, priceDelta });
        inp.value = '';
        if (priceInp) priceInp.value = '';
        renderOptChips();
        inp.focus();
    }

    // Çıkarılabilir/ekstra ürün bileşenleri (ör. "Soğansız", "Ekstra Peynir").
    // options'tan farkı: misafir TEK değil BİRDEN FAZLA seçebilir (bkz.
    // guest-order.js item sheet'indeki çoklu-seçim chip listesi).
    function normalizeModifier(m) {
        return {
            name: String((m && m.name) || '').trim().slice(0, 40),
            type: (m && m.type) === 'extra' ? 'extra' : 'remove',
            priceDelta: Number(m && m.priceDelta) || 0
        };
    }
    function renderModChips() {
        const wrap = $('catModList'); if (!wrap) return;
        if (!editingModifiers.length) { wrap.innerHTML = `<span class="cat-opt-empty">Henüz özelleştirme eklenmedi.</span>`; return; }
        wrap.innerHTML = editingModifiers.map((m, i) => {
            const label = (m.type === 'extra' ? '+ ' : '− ') + m.name + (m.priceDelta ? ` (${m.priceDelta > 0 ? '+' : ''}${m.priceDelta}₺)` : '');
            return `<span class="cat-opt-chip">${esc(label)}<button type="button" data-moddel="${i}" aria-label="Kaldır">✕</button></span>`;
        }).join('');
        wrap.querySelectorAll('[data-moddel]').forEach(b => b.onclick = () => {
            editingModifiers.splice(+b.dataset.moddel, 1);
            renderModChips();
        });
    }
    function addModifier() {
        const inp = $('catModInput'); if (!inp) return;
        const typeSel = $('catModType'), priceInp = $('catModPriceInput');
        const val = inp.value.trim().slice(0, 40);
        if (!val) return;
        if (editingModifiers.some(m => m.name.toLowerCase() === val.toLowerCase())) { toast('Bu özelleştirme zaten ekli.', true); inp.value = ''; return; }
        if (editingModifiers.length >= 10) { toast('En fazla 10 özelleştirme ekleyebilirsiniz.', true); return; }
        const type = typeSel && typeSel.value === 'extra' ? 'extra' : 'remove';
        const priceDelta = priceInp ? (Number(priceInp.value) || 0) : 0;
        editingModifiers.push({ name: val, type, priceDelta });
        inp.value = '';
        if (priceInp) priceInp.value = '';
        renderModChips();
        inp.focus();
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
            options: editingOptions.slice(),
            modifiers: editingModifiers.slice(),
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

    async function remove() {
        if (!editingId) return;
        const ok = await AppDialog.confirm({ title: 'Talebi sil', danger: true, confirmText: 'Sil', message: 'Bu talebi silmek istediğinize emin misiniz?' });
        if (!ok) return;
        db.collection(COL).doc(editingId).delete()
            .then(() => { toast('Talep silindi.'); closeModal(); })
            .catch(err => { console.error(err); toast('Silinemedi.', true); });
    }

    async function seedDefaults() {
        if (items.length) {
            const ok = await AppDialog.confirm({ title: 'Varsayılanları yükle', confirmText: 'Ekle', message: 'Mevcut listeye varsayılan talepler eklensin mi? (Aynı isimdekiler atlanır)' });
            if (!ok) return;
        }
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

    // seedDefaults()'ın tersi: isim eşleşmesiyle (case-insensitive) eklenmiş
    // varsayılan talepleri toplu siler. Yalnızca varsayılan LİSTESİNDEKİ
    // isimlerle eşleşenleri hedefler — admin'in kendi eklediği/isim
    // değiştirdiği talepler dokunulmadan kalır.
    async function unseedDefaults() {
        const defaultNames = new Set(DEFAULTS.map(d => d.name.toLowerCase()));
        const matches = items.filter(i => defaultNames.has((i.name || '').toLowerCase()));
        if (!matches.length) { toast('Kaldırılacak varsayılan talep yok.'); return; }
        const ok = await AppDialog.confirm({
            title: 'Varsayılanları kaldır', danger: true, confirmText: 'Kaldır',
            message: matches.length + ' varsayılan talep silinecek (isim eşleşmesiyle bulundu; kendi eklediğiniz/adını değiştirdiğiniz talepler etkilenmez). Devam edilsin mi?'
        });
        if (!ok) return;
        const batch = db.batch();
        matches.forEach(i => batch.delete(db.collection(COL).doc(i.id)));
        batch.commit().then(() => toast(matches.length + ' varsayılan talep kaldırıldı.')).catch(err => { console.error(err); toast('Kaldırılamadı.', true); });
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
            const hn = $('cfgHotelName'), cur = $('cfgCurrency'), sp = $('cfgShowPrices');
            if (hn) hn.value = cfg.hotelName || '';
            if (cur) cur.value = cfg.currency || '₺';
            if (sp) sp.checked = !!cfg.showPrices;
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
    // ── Excel/CSV şablon indir + yükle (toplu ekle/düzenle) ─────
    // Gerçek .xlsx yerine bilinçli olarak CSV kullanılır: harici bir
    // kütüphane (CDN) gerektirmez, Excel .csv dosyalarını doğrudan açar/
    // kaydeder — kullanıcı deneyimi aynı ("indir, doldur, yükle"), ancak
    // dış bağımlılık riski yok. Sütun ayıracı olarak `;` seçildi (Türkçe
    // Excel varsayılanı `,`'yi ondalık ayıracı sayar, .csv'yi tek sütunda
    // açabilir) — "Seçenekler" listesi bu yüzden `,` ile ayrılır.
    const CSV_HEADERS = ['Talep Adı', 'Kategori', 'Alt Kategori', 'İkon', 'Departman', 'Açıklama', 'Fiyat', 'Süre', 'Maks Adet', 'Uygun Başlangıç', 'Uygun Bitiş', 'Aktif', 'Seçenekler'];
    function csvEscape(s) {
        s = String(s == null ? '' : s);
        return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function exportCsv() {
        const rows = items.length ? items.slice().sort(byOrder) : [{
            name: 'Örnek: Ekstra Havlu', category: 'Konfor', subcategory: '', icon: '🧺', department: '',
            description: '', price: 0, eta: '15 dk', maxQty: 1, availFrom: '', availTo: '', active: true, options: []
        }];
        const lines = [CSV_HEADERS.join(';')];
        rows.forEach(it => {
            lines.push([
                it.name, it.category, it.subcategory || '', it.icon || '', it.department || '',
                it.description || '', it.price || 0, it.eta || '', it.maxQty || 0,
                it.availFrom || '', it.availTo || '', (it.active !== false) ? 'Evet' : 'Hayır',
                (it.options || []).join(', ')
            ].map(csvEscape).join(';'));
        });
        const csv = '\uFEFF' + lines.join('\r\n'); // BOM: Excel'de Türkçe karakterler doğru görünsün
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'hazir-talepler-sablon.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    // RFC4180 benzeri basit ayrıştırıcı: tırnaklı alanlar (`;`/`"`/satır sonu
    // içerebilir), çift tırnak kaçışı (""), CRLF/LF.
    function parseCsv(text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const rows = []; let row = [], field = '', inQuotes = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inQuotes) {
                if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
                else field += c;
            } else if (c === '"') inQuotes = true;
            else if (c === ';') { row.push(field); field = ''; }
            else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
            else if (c === '\r') { /* \n satır sonunu ele alır */ }
            else field += c;
        }
        if (field.length || row.length) { row.push(field); rows.push(row); }
        return rows.filter(r => r.some(c => c.trim() !== ''));
    }
    function itemKey(name, category) {
        return (String(name || '').trim() + '␟' + String(category || '').trim()).toLocaleLowerCase('tr-TR');
    }
    function commitBulkOps(ops, skipped, badDept) {
        const CHUNK = 450;
        const chunks = [];
        for (let i = 0; i < ops.length; i += CHUNK) chunks.push(ops.slice(i, i + CHUNK));
        let p = Promise.resolve();
        chunks.forEach(chunk => {
            p = p.then(() => {
                const b = db.batch();
                chunk.forEach(op => op.isNew ? b.set(op.ref, op.data) : b.update(op.ref, op.data));
                return b.commit();
            });
        });
        return p.then(() => {
            const added = ops.filter(o => o.isNew).length, updated = ops.length - added;
            let msg = added + ' eklendi, ' + updated + ' güncellendi.';
            if (skipped && skipped.length) msg += ' (' + skipped.length + ' satır atlandı — satır ' + skipped.join(', ') + ': Ad/Kategori eksik)';
            if (badDept && badDept.length) msg += ' (' + badDept.length + ' satır atlandı — satır ' + badDept.join(', ') + ': Departman tanınmıyor, Ayarlar → Departmanlar listesinden bir ad kullanın)';
            toast(msg, !!(badDept && badDept.length));
        }, err => { console.error(err); toast('Yükleme sırasında hata: ' + err.message, true); });
    }
    function importCsvFile(file) {
        const reader = new FileReader();
        reader.onload = () => {
            let rows;
            try { rows = parseCsv(String(reader.result)); }
            catch (e) { console.error(e); toast('Dosya okunamadı: ' + e.message, true); return; }
            if (rows.length < 2) { toast('Dosyada veri satırı bulunamadı.', true); return; }
            const header = rows[0].map(h => h.trim());
            const idx = {};
            CSV_HEADERS.forEach(h => { idx[h] = header.indexOf(h); });
            if (idx['Talep Adı'] === -1 || idx['Kategori'] === -1) {
                toast('Şablon başlıkları tanınmadı — lütfen "Şablon İndir" ile indirilen dosyayı kullanın.', true);
                return;
            }
            const existingMap = new Map(items.map(it => [itemKey(it.name, it.category), it]));
            let maxOrder = items.reduce((m, i) => Math.max(m, i.sortOrder || 0), 0);
            // Departman doğrulaması: eskiden bu sütun serbest metindi ve HİÇ
            // kontrol edilmiyordu — "Housekeeeping" gibi bir yazım hatası
            // sessizce kaydediliyor, o talebi hiçbir personel üstlenemiyordu.
            // Otelin gerçek departman listesiyle (büyük/küçük harf duyarsız)
            // karşılaştırılır; tanınmayan değer satırı REDDEDER (boş bırakmak
            // hâlâ serbest — kategoriye göre otomatik çözümlenir).
            const knownDepts = new Map(deptOptions().map(n => [n.toLocaleLowerCase('tr-TR'), n]));
            const ops = [], skipped = [], badDept = [];
            for (let r = 1; r < rows.length; r++) {
                const cols = rows[r];
                const get = (h) => { const i = idx[h]; return (i == null || i === -1 || i >= cols.length) ? '' : String(cols[i] || '').trim(); };
                const name = get('Talep Adı').slice(0, 120);
                const category = get('Kategori').slice(0, 60);
                if (!name || !category) { skipped.push(r + 1); continue; }
                const deptRaw = get('Departman').slice(0, 60);
                if (deptRaw && !knownDepts.has(deptRaw.toLocaleLowerCase('tr-TR'))) { badDept.push(r + 1); continue; }
                // Listedeki kanonik yazımı kullan (kullanıcının büyük/küçük
                // harf farkı kaydı bozmasın).
                const department = deptRaw ? knownDepts.get(deptRaw.toLocaleLowerCase('tr-TR')) : '';
                const activeRaw = get('Aktif').toLocaleLowerCase('tr-TR');
                const active = activeRaw === '' || ['evet', 'true', '1', 'x', 'aktif'].indexOf(activeRaw) !== -1;
                const options = get('Seçenekler').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10).map(s => s.slice(0, 40));
                const data = {
                    tenantId: TENANT_ID, name, category,
                    subcategory: get('Alt Kategori').slice(0, 60),
                    icon: (get('İkon') || '🛎️').slice(0, 8),
                    department,
                    description: get('Açıklama').slice(0, 160),
                    price: Math.max(0, parseInt(get('Fiyat'), 10) || 0),
                    eta: get('Süre').slice(0, 20),
                    maxQty: Math.max(0, parseInt(get('Maks Adet'), 10) || 0),
                    availFrom: get('Uygun Başlangıç'), availTo: get('Uygun Bitiş'),
                    active, options,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                };
                const existing = existingMap.get(itemKey(name, category));
                if (existing) {
                    ops.push({ ref: db.collection(COL).doc(existing.id), data, isNew: false });
                } else {
                    maxOrder += 10;
                    data.sortOrder = maxOrder;
                    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                    ops.push({ ref: db.collection(COL).doc(), data, isNew: true });
                }
            }
            if (!ops.length) {
                let why = 'İşlenecek satır bulunamadı.';
                if (badDept.length) why = 'Hiçbir satır işlenemedi (satır ' + badDept.join(', ') + ': Departman tanınmıyor — Ayarlar → Departmanlar listesindeki adlardan birini kullanın veya boş bırakın).';
                else if (skipped.length) why = 'Hiçbir satır işlenemedi (satır ' + skipped.join(', ') + ': Ad/Kategori eksik).';
                toast(why, true);
                return;
            }
            commitBulkOps(ops, skipped, badDept);
        };
        reader.onerror = () => toast('Dosya okunamadı.', true);
        reader.readAsText(file, 'utf-8');
    }

    // ── Hızlı Toplu Ekle — birden fazla basit satırı tek seferde ekler ──
    // Sabit İngilizce liste yerine otelin KENDİ departmanları (bkz.
    // deptOptions/fillDeptSelect gerekçesi) — her satır oluşturulurken
    // yeniden okunur ki Departmanlar sekmesindeki değişiklik anında yansısın.
    const bulkDepts = () => [''].concat(deptOptions());
    let bulkRowSeq = 0;
    function bulkRowHtml() {
        const id = bulkRowSeq++;
        return `<div class="cat-bulk-row" data-row="${id}">
            <select class="cbr-dept">${bulkDepts().map(d => `<option value="${esc(d)}">${d ? esc(d) : 'Otomatik'}</option>`).join('')}</select>
            <input type="text" class="cbr-name" maxlength="120" placeholder="Talep adı">
            <input type="text" class="cbr-cat" maxlength="60" list="catCatOptions" placeholder="Kategori">
            <input type="number" class="cbr-price" min="0" step="1" placeholder="Fiyat">
            <button type="button" class="cat-bulk-row-del" data-del="${id}" aria-label="Satırı kaldır">✕</button>
        </div>`;
    }
    function wireBulkRowDelete() {
        $('catBulkRows').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
            const row = b.closest('.cat-bulk-row'); if (row) row.remove();
        });
    }
    function openBulkModal() {
        bulkRowSeq = 0;
        const wrap = $('catBulkRows'); if (!wrap) return;
        wrap.innerHTML = Array.from({ length: 5 }, bulkRowHtml).join('');
        wireBulkRowDelete();
        $('catBulkModal').style.display = 'flex';
    }
    function closeBulkModal() { $('catBulkModal').style.display = 'none'; }
    function addBulkRow() {
        const wrap = $('catBulkRows'); if (!wrap) return;
        if (wrap.children.length >= 30) { toast('En fazla 30 satır ekleyebilirsiniz.', true); return; }
        wrap.insertAdjacentHTML('beforeend', bulkRowHtml());
        wireBulkRowDelete();
    }
    function submitBulk() {
        const rows = Array.from($('catBulkRows').querySelectorAll('.cat-bulk-row'));
        let order = items.reduce((m, i) => Math.max(m, i.sortOrder || 0), 0);
        const toAdd = [], badRows = [];
        rows.forEach((row, i) => {
            const name = row.querySelector('.cbr-name').value.trim().slice(0, 120);
            const category = row.querySelector('.cbr-cat').value.trim().slice(0, 60);
            if (!name && !category) return; // tamamen boş satır — sessizce atla
            if (!name || !category) { badRows.push(i + 1); return; }
            order += 10;
            toAdd.push({
                tenantId: TENANT_ID, name, category, subcategory: '', icon: '🛎️',
                department: row.querySelector('.cbr-dept').value,
                description: '', price: Math.max(0, parseInt(row.querySelector('.cbr-price').value, 10) || 0),
                eta: '', maxQty: 0, availFrom: '', availTo: '', active: true, options: [], sortOrder: order,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        });
        if (badRows.length) { toast('Satır ' + badRows.join(', ') + ': Ad ve Kategori zorunlu.', true); return; }
        if (!toAdd.length) { toast('Eklenecek satır yok.', true); return; }
        const b = db.batch();
        toAdd.forEach(data => b.set(db.collection(COL).doc(), data));
        b.commit().then(() => {
            toast(toAdd.length + ' talep eklendi.');
            closeBulkModal();
        }).catch(err => { console.error(err); toast('Eklenemedi: ' + err.message, true); });
    }

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
            const tab = document.querySelector('.sb-link[data-view="catalog"]');
            if (tab) tab.remove();
            const view = $('view-catalog');
            if (view) view.remove();
            return;
        }
        injectStyles();
        $('catSearch') && $('catSearch').addEventListener('input', (e) => { searchTerm = e.target.value; render(); });
        $('catAddBtn') && ($('catAddBtn').onclick = () => openModal(null));
        $('catSeedBtn') && ($('catSeedBtn').onclick = seedDefaults);
        $('catUnseedBtn') && ($('catUnseedBtn').onclick = unseedDefaults);
        $('catExportBtn') && ($('catExportBtn').onclick = exportCsv);
        $('catImportBtn') && ($('catImportBtn').onclick = () => $('catImportInput').click());
        $('catImportInput') && ($('catImportInput').onchange = (e) => {
            const f = e.target.files && e.target.files[0];
            if (f) importCsvFile(f);
            e.target.value = '';
        });
        $('catBulkAddBtn') && ($('catBulkAddBtn').onclick = openBulkModal);
        $('closeCatBulkModal') && ($('closeCatBulkModal').onclick = closeBulkModal);
        $('catBulkAddRowBtn') && ($('catBulkAddRowBtn').onclick = addBulkRow);
        $('catBulkSubmitBtn') && ($('catBulkSubmitBtn').onclick = submitBulk);
        const bulkModal = $('catBulkModal');
        if (bulkModal) bulkModal.addEventListener('click', e => { if (e.target === bulkModal) closeBulkModal(); });
        $('catOptAddBtn') && ($('catOptAddBtn').onclick = addOption);
        $('catOptInput') && $('catOptInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } });
        $('catOptPriceInput') && $('catOptPriceInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } });
        $('catModAddBtn') && ($('catModAddBtn').onclick = addModifier);
        $('catModInput') && $('catModInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addModifier(); } });
        $('catModPriceInput') && $('catModPriceInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addModifier(); } });
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
