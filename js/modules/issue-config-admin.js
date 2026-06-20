/* StayOS — Admin management for guest-record departments & topics (issueConfig).
 *
 * Included on admin.html. Powers the "Departman & Konu" tab: a single list of
 * departments, each tagged talep / şikayet / her ikisi, with optional topics
 * (sub-categories). Saved as one tenant-scoped doc (issueConfig/{TENANT_ID}).
 * Guarded by the same admin auth as the rest of the page; security rules also
 * require an admin in the matching tenant.
 */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') return;

    const COL = 'issueConfig';
    let depts = [];
    let editingIdx = -1;
    let unsub = null;

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

    function kindLabel(k) {
        return k === 'request' ? 'Talep' : (k === 'complaint' ? 'Şikayet' : 'Talep & Şikayet');
    }

    // ── Styles ─────────────────────────────────────────────────
    function injectStyles() {
        if ($('iss-admin-styles')) return;
        const css = `
        .iss-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
        .iss-card { background: #fff; border: 1px solid #e8edf2; border-radius: 14px; padding: 14px;
            cursor: pointer; transition: border-color .15s, box-shadow .15s; }
        .iss-card:hover { border-color: #c7d2fe; box-shadow: 0 6px 18px rgba(99,102,241,.1); }
        .iss-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
        .iss-name { font-size: 15px; font-weight: 800; color: #1e293b; }
        .iss-kind { font-size: 10px; font-weight: 800; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
        .iss-kind.k-both { background: #eef2ff; color: #4f46e5; }
        .iss-kind.k-request { background: #ecfdf5; color: #059669; }
        .iss-kind.k-complaint { background: #fff7ed; color: #d97706; }
        .iss-topics { display: flex; flex-wrap: wrap; gap: 6px; }
        .iss-chip { font-size: 11.5px; font-weight: 600; color: #475569; background: #f1f5f9;
            padding: 4px 10px; border-radius: 999px; }
        .iss-none { font-size: 11.5px; color: #94a3b8; font-style: italic; }
        .iss-empty { text-align: center; color: #94a3b8; padding: 40px 20px; font-size: 14px; }`;
        const el = document.createElement('style');
        el.id = 'iss-admin-styles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    // ── Render ─────────────────────────────────────────────────
    function render() {
        const wrap = $('issueList');
        if (!wrap) return;
        if (!depts.length) {
            wrap.innerHTML = `<div class="iss-empty">Henüz departman eklenmemiş.<br>“Varsayılanları Yükle” ile başlayabilir veya “Departman Ekle” diyebilirsiniz.</div>`;
            return;
        }
        wrap.innerHTML = `<div class="iss-grid">` + depts.map((d, i) => {
            const topics = (d.topics || []).length
                ? d.topics.map(t => `<span class="iss-chip">${esc(t)}</span>`).join('')
                : `<span class="iss-none">Konu yok</span>`;
            return `<div class="iss-card" data-i="${i}">
                <div class="iss-card-head">
                    <span class="iss-name">${esc(d.name)}</span>
                    <span class="iss-kind k-${esc(d.kind || 'both')}">${esc(kindLabel(d.kind))}</span>
                </div>
                <div class="iss-topics">${topics}</div>
            </div>`;
        }).join('') + `</div>`;
        wrap.querySelectorAll('[data-i]').forEach(c => c.onclick = () => openModal(+c.dataset.i));
    }

    // ── Modal ──────────────────────────────────────────────────
    function openModal(idx) {
        editingIdx = (typeof idx === 'number' && idx >= 0) ? idx : -1;
        const d = editingIdx >= 0 ? depts[editingIdx] : null;
        $('issueModalTitle').textContent = d ? 'Departmanı Düzenle' : 'Departman Ekle';
        $('issName').value = d ? (d.name || '') : '';
        $('issKind').value = d ? (d.kind || 'both') : 'both';
        $('issTopics').value = d ? (d.topics || []).join('\n') : '';
        $('issueDeleteBtn').style.display = d ? 'block' : 'none';
        $('issueModal').style.display = 'flex';
    }
    function closeModal() {
        $('issueModal').style.display = 'none';
        editingIdx = -1;
    }

    function persist(msg) {
        return db.collection(COL).doc(TENANT_ID).set({
            tenantId: TENANT_ID,
            departments: depts,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true })
            .then(() => { if (msg) toast(msg); })
            .catch(err => { console.error(err); toast('Kaydedilemedi.', true); throw err; });
    }

    function save(e) {
        e.preventDefault();
        const name = $('issName').value.trim();
        if (!name) { toast('Departman adı zorunlu.', true); return; }
        const kind = $('issKind').value;
        // One topic per line; trimmed + de-duplicated (case-insensitive).
        const seen = Object.create(null);
        const topics = $('issTopics').value.split('\n')
            .map(s => s.trim()).filter(Boolean)
            .filter(t => { const k = t.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; });
        const obj = { name: name, kind: kind, topics: topics };

        if (editingIdx >= 0) {
            depts[editingIdx] = obj;
        } else {
            if (depts.some(d => (d.name || '').toLowerCase() === name.toLowerCase())) {
                toast('Bu departman zaten var.', true);
                return;
            }
            depts.push(obj);
        }
        persist(editingIdx >= 0 ? 'Departman güncellendi.' : 'Departman eklendi.').then(closeModal).catch(() => {});
    }

    function remove() {
        if (editingIdx < 0) return;
        if (!confirm('Bu departmanı silmek istediğinize emin misiniz?')) return;
        depts.splice(editingIdx, 1);
        persist('Departman silindi.').then(closeModal).catch(() => {});
    }

    function seedDefaults() {
        const defs = (window.IssueConfig && IssueConfig.DEFAULTS) || [];
        if (depts.length && !confirm('Varsayılan departmanlar eklensin mi? (Aynı isimdekiler atlanır)')) return;
        const names = Object.create(null);
        depts.forEach(d => names[(d.name || '').toLowerCase()] = 1);
        let added = 0;
        defs.forEach(d => {
            if (names[(d.name || '').toLowerCase()]) return;
            depts.push({ name: d.name, kind: d.kind || 'both', topics: (d.topics || []).slice() });
            added++;
        });
        if (!added) { toast('Eklenecek yeni departman yok.'); return; }
        persist(added + ' departman eklendi.').catch(() => {});
    }

    // ── Listen ─────────────────────────────────────────────────
    function normalize(list) {
        if (!Array.isArray(list)) return [];
        return list.map(d => ({
            name: String((d && d.name) || '').trim(),
            kind: (d && (d.kind === 'request' || d.kind === 'complaint')) ? d.kind : 'both',
            topics: (d && Array.isArray(d.topics)) ? d.topics.map(t => String(t || '').trim()).filter(Boolean) : []
        })).filter(d => d.name);
    }
    function listen() {
        if (unsub) return;
        unsub = db.collection(COL).doc(TENANT_ID).onSnapshot(snap => {
            const data = snap.exists ? snap.data() : null;
            depts = normalize(data && data.departments);
            render();
        }, err => console.error('issueConfig listen failed', err));
    }

    // ── Boot ───────────────────────────────────────────────────
    function boot() {
        // Feature-gated: if the hotel's plan doesn't include "Misafir Kayıtları"
        // (guestIssues), drop the admin tab entirely.
        if (typeof moduleEnabled === 'function' && !moduleEnabled('guestIssues')) {
            const tab = document.querySelector('.adm-tab[data-view="issues"]');
            if (tab) tab.remove();
            const view = $('view-issues');
            if (view) view.remove();
            return;
        }
        injectStyles();
        $('issAddBtn') && ($('issAddBtn').onclick = () => openModal(-1));
        $('issSeedBtn') && ($('issSeedBtn').onclick = seedDefaults);
        $('closeIssueModal') && ($('closeIssueModal').onclick = closeModal);
        $('issueDeptForm') && ($('issueDeptForm').onsubmit = save);
        $('issueDeleteBtn') && ($('issueDeleteBtn').onclick = remove);
        const modal = $('issueModal');
        if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
        auth.onAuthStateChanged(u => { if (u) listen(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
