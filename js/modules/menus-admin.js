/* Hotizy — Menüler (PDF) admin yönetimi (admin.html "Hazır Talepler" görünümü).
 *
 * guestMenus/{id} = { tenantId, name, pdfUrl, sortOrder, active, updatedAt }
 * Misafir QR sayfasındaki "Menüler" carousel kartı bu listeyi okur; her öğe
 * admin'in yapıştırdığı bir PDF bağlantısına (Drive, otel web sitesi vb.)
 * açılır. Dosya yükleme yok — Hotizy henüz Firebase Storage kullanmıyor.
 */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') return;

    var COL = 'guestMenus';
    var $ = function (id) { return document.getElementById(id); };
    var menus = []; // [{ id, name, pdfUrl, sortOrder, active }]

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function toast(msg, isErr) {
        var t = $('toast'); if (!t) { alert(msg); return; }
        t.textContent = msg; t.className = 'toast-notification show' + (isErr ? ' error' : '');
        setTimeout(function () { t.className = 'toast-notification'; }, 2600);
    }

    function injectStyles() {
        if (document.getElementById('menus-admin-styles')) return;
        var css = ''
            + '.menu-add-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }'
            + '.menu-add-row input { flex:1; min-width:160px; padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:13.5px; }'
            + '.menu-row { display:flex; align-items:center; gap:10px; background:#fff; border:1px solid #e8edf2; border-radius:12px; padding:10px 12px; margin-bottom:8px; }'
            + '.menu-row.inactive { opacity:.55; }'
            + '.menu-row input[type=text] { flex:1; min-width:120px; border:1px solid transparent; background:transparent; padding:6px 8px; border-radius:6px; font-size:13.5px; font-weight:600; color:#1e293b; }'
            + '.menu-row input[type=text]:focus { border-color:#c7d2fe; background:#f8fafc; outline:none; }'
            + '.menu-row .menu-url { font-weight:400; color:#64748b; flex:1.4; }'
            + '.menu-row .menu-ord { display:flex; gap:2px; flex-shrink:0; }'
            + '.menu-row .menu-ord button { width:26px; height:26px; border:1px solid #e2e8f0; background:#fff; border-radius:6px; cursor:pointer; font-size:12px; color:#475569; }'
            + '.menu-row .menu-del { flex-shrink:0; background:#fef2f2; color:#dc2626; border:none; border-radius:6px; padding:6px 10px; font-size:12px; font-weight:700; cursor:pointer; }'
            + '.menu-empty { text-align:center; color:#94a3b8; font-size:13.5px; padding:20px; }';
        var st = document.createElement('style'); st.id = 'menus-admin-styles'; st.textContent = css;
        document.head.appendChild(st);
    }

    function load() {
        db.collection(COL).where('tenantId', '==', TENANT_ID).onSnapshot(function (snap) {
            menus = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
                .sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });
            render();
        }, function () { menus = []; render(); });
    }

    function render() {
        var wrap = $('menuList'); if (!wrap) return;
        if (!menus.length) { wrap.innerHTML = '<div class="menu-empty">Henüz menü eklenmemiş.</div>'; return; }
        wrap.innerHTML = menus.map(function (m, i) {
            return '<div class="menu-row' + (m.active === false ? ' inactive' : '') + '" data-id="' + esc(m.id) + '">'
                + '<input type="text" class="menu-name" value="' + esc(m.name || '') + '" placeholder="Menü adı (ör. Restoran Menüsü)">'
                + '<input type="text" class="menu-url" value="' + esc(m.pdfUrl || '') + '" placeholder="PDF bağlantısı (https://…)">'
                + '<label style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:#64748b;flex-shrink:0;">'
                + '<input type="checkbox" class="menu-active" ' + (m.active === false ? '' : 'checked') + '> Aktif</label>'
                + '<div class="menu-ord">'
                + '<button class="menu-up" ' + (i === 0 ? 'disabled' : '') + ' title="Yukarı">↑</button>'
                + '<button class="menu-down" ' + (i === menus.length - 1 ? 'disabled' : '') + ' title="Aşağı">↓</button>'
                + '</div>'
                + '<button class="menu-del" title="Sil">Sil</button>'
                + '</div>';
        }).join('');

        wrap.querySelectorAll('.menu-row').forEach(function (row) {
            var id = row.dataset.id;
            var nameEl = row.querySelector('.menu-name');
            var urlEl = row.querySelector('.menu-url');
            var activeEl = row.querySelector('.menu-active');
            var saveField = function (patch) {
                db.collection(COL).doc(id).update(Object.assign({ updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, patch))
                    .catch(function () { toast('Kaydedilemedi.', true); });
            };
            nameEl.addEventListener('blur', function () { saveField({ name: nameEl.value.trim().slice(0, 80) }); });
            urlEl.addEventListener('blur', function () { saveField({ pdfUrl: urlEl.value.trim().slice(0, 500) }); });
            activeEl.addEventListener('change', function () { saveField({ active: activeEl.checked }); });
            var delBtn = row.querySelector('.menu-del');
            delBtn.addEventListener('click', function () {
                if (!confirm('Bu menüyü silmek istediğinize emin misiniz?')) return;
                db.collection(COL).doc(id).delete().catch(function () { toast('Silinemedi.', true); });
            });
            var upBtn = row.querySelector('.menu-up'), downBtn = row.querySelector('.menu-down');
            var idx = menus.findIndex(function (m) { return m.id === id; });
            if (upBtn && !upBtn.disabled) upBtn.addEventListener('click', function () { swapOrder(idx, idx - 1); });
            if (downBtn && !downBtn.disabled) downBtn.addEventListener('click', function () { swapOrder(idx, idx + 1); });
        });
    }

    // Komşu iki menünün sortOrder'ını değiştirir (basit yeniden sıralama).
    function swapOrder(i, j) {
        var a = menus[i], b = menus[j]; if (!a || !b) return;
        var oa = (a.sortOrder || 0), ob = (b.sortOrder || 0);
        var batch = db.batch();
        batch.update(db.collection(COL).doc(a.id), { sortOrder: ob });
        batch.update(db.collection(COL).doc(b.id), { sortOrder: oa });
        batch.commit().catch(function () { toast('Sıralama kaydedilemedi.', true); });
    }

    function addMenu() {
        var nameEl = $('menuNewName'), urlEl = $('menuNewUrl');
        var name = (nameEl.value || '').trim().slice(0, 80);
        var pdfUrl = (urlEl.value || '').trim().slice(0, 500);
        if (!name) { toast('Menü adı girin.', true); return; }
        var maxOrder = menus.reduce(function (m, x) { return Math.max(m, x.sortOrder || 0); }, 0);
        db.collection(COL).add({
            tenantId: TENANT_ID, name: name, pdfUrl: pdfUrl, active: true, sortOrder: maxOrder + 1,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }).then(function () {
            nameEl.value = ''; urlEl.value = '';
            toast('Menü eklendi.');
        }).catch(function () { toast('Eklenemedi. Yetkiniz olmayabilir.', true); });
    }

    document.addEventListener('DOMContentLoaded', function () {
        if (!$('menuList')) return;
        injectStyles();
        var addBtn = $('menuAddBtn'); if (addBtn) addBtn.onclick = addMenu;
        if (typeof auth !== 'undefined') auth.onAuthStateChanged(function (u) { if (u) load(); });
        else load();
    });
})();
