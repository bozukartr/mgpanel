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
    var toast = window.showToast; // js/utils/toast.js (paylaşımlı)

    // Stiller css/modules/admin.css'e taşındı (Ayarlar paneli yeniden tasarımı).
    function injectStyles() {}

    function load() {
        db.collection(COL).where('tenantId', '==', TENANT_ID).onSnapshot(function (snap) {
            menus = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
                .sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });
            render();
        }, function () { menus = []; render(); });
    }

    function render() {
        var wrap = $('menuList'); if (!wrap) return;
        if (!menus.length) { wrap.innerHTML = '<div class="menu-empty">Henüz menü eklenmemiş. Yukarıdan ad ve PDF bağlantısıyla ekleyin.</div>'; return; }
        wrap.innerHTML = menus.map(function (m, i) {
            return '<div class="menu-row' + (m.active === false ? ' inactive' : '') + '" data-id="' + esc(m.id) + '">'
                + '<input type="text" class="menu-name" value="' + esc(m.name || '') + '" placeholder="Menü adı (ör. Restoran Menüsü)">'
                + '<input type="text" class="menu-url" value="' + esc(m.pdfUrl || '') + '" placeholder="PDF bağlantısı (https://…)">'
                + '<label>'
                + '<input type="checkbox" class="menu-active" ' + (m.active === false ? '' : 'checked') + '> Aktif</label>'
                + '<div class="menu-ord">'
                + '<button class="menu-up" ' + (i === 0 ? 'disabled' : '') + ' title="Yukarı taşı" aria-label="Yukarı taşı">↑</button>'
                + '<button class="menu-down" ' + (i === menus.length - 1 ? 'disabled' : '') + ' title="Aşağı taşı" aria-label="Aşağı taşı">↓</button>'
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
                AppDialog.confirm({ title: 'Menüyü sil', danger: true, confirmText: 'Sil', message: 'Bu menüyü silmek istediğinize emin misiniz?' }).then(function (ok) {
                    if (!ok) return;
                    db.collection(COL).doc(id).delete().catch(function () { toast('Silinemedi.', true); });
                });
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
