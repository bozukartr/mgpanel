/* Hotizy — Admin management for guest-record departments & topics (issueConfig).
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
    const toast = window.showToast; // js/utils/toast.js (paylaşımlı)

    function kindLabel(k) {
        return k === 'request' ? 'Talep' : (k === 'complaint' ? 'Şikayet' : 'Talep & Şikayet');
    }

    // ── Styles ─────────────────────────────────────────────────
    // Stiller css/modules/admin.css'e taşındı (Ayarlar paneli yeniden tasarımı).
    function injectStyles() {}

    // ── Render ─────────────────────────────────────────────────
    function render() {
        const wrap = $('issueList');
        if (!wrap) return;
        if (!depts.length) {
            wrap.innerHTML = `<div class="iss-empty">Henüz departman eklenmemiş.<br>"Varsayılanları yükle" ile hazır listeyle başlayabilir ya da "Departman ekle" diyebilirsiniz.</div>`;
            return;
        }
        wrap.innerHTML = `<div class="iss-grid">` + depts.map((d, i) => {
            return `<div class="iss-card" data-i="${i}">
                <div class="iss-card-head">
                    <span class="iss-name">${esc(d.name)}</span>
                    <span class="iss-kind k-${esc(d.kind || 'both')}">${esc(kindLabel(d.kind))}</span>
                </div>
                <div class="iss-meta">Yanıt süresi: ${d.sla ? esc(String(d.sla)) + ' dk' : 'varsayılan (15 dk)'}</div>
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
        if ($('issSla')) $('issSla').value = (d && d.sla) ? d.sla : '';
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
        const slaRaw = $('issSla') ? $('issSla').value.trim() : '';
        const sla = slaRaw ? Math.max(1, parseInt(slaRaw, 10) || 0) : 0;
        const obj = { name: name, kind: kind };
        if (sla > 0) obj.sla = sla; // boş → alan yazılmaz (varsayılan SLA'ya düşer)

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

    async function remove() {
        if (editingIdx < 0) return;
        const ok = await AppDialog.confirm({ title: 'Departmanı sil', danger: true, confirmText: 'Sil', message: 'Bu departmanı silmek istediğinize emin misiniz?' });
        if (!ok) return;
        depts.splice(editingIdx, 1);
        persist('Departman silindi.').then(closeModal).catch(() => {});
    }

    async function seedDefaults() {
        const defs = (window.IssueConfig && IssueConfig.DEFAULTS) || [];
        if (depts.length) {
            const ok = await AppDialog.confirm({ title: 'Varsayılanları yükle', confirmText: 'Ekle', message: 'Varsayılan departmanlar eklensin mi? (Aynı isimdekiler atlanır)' });
            if (!ok) return;
        }
        const names = Object.create(null);
        depts.forEach(d => names[(d.name || '').toLowerCase()] = 1);
        let added = 0;
        defs.forEach(d => {
            if (names[(d.name || '').toLowerCase()]) return;
            depts.push({ name: d.name, kind: d.kind || 'both' });
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
            ...(d && Number(d.sla) > 0 ? { sla: Math.round(Number(d.sla)) } : {})
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

    // ── Konular (topics) ───────────────────────────────────────
    let topicEntries = [];
    function renderTopics() {
        const wrap = $('issTopicList');
        if (!wrap) return;
        if (!topicEntries.length) {
            wrap.innerHTML = `<div class="iss-topic-empty">Henüz konu eklenmemiş. Şikayet eklerken yazılan konular burada birikir.</div>`;
            return;
        }
        wrap.innerHTML = topicEntries.map(t => `
            <span class="iss-topic-pill">${esc(t.name)}
                <button type="button" data-del="${esc(t.id)}" title="Sil" aria-label="Sil">&times;</button>
            </span>`).join('');
        wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => removeTopic(b.dataset.del));
    }
    async function removeTopic(id) {
        const entry = topicEntries.filter(t => t.id === id)[0];
        const name = entry ? entry.name : '';
        const ok = await AppDialog.confirm({ title: 'Konuyu sil', danger: true, confirmText: 'Sil', message: `"${name}" konusu öneri listesinden silinsin mi? (Mevcut kayıtlar etkilenmez)` });
        if (!ok) return;
        if (window.IssueConfig) IssueConfig.deleteTopic(id).then(() => toast('Konu silindi.')).catch(() => toast('Silinemedi.', true));
    }
    async function addTopicPrompt() {
        const name = (await AppDialog.prompt({ title: 'Konu ekle', message: 'Yeni konu adı:', placeholder: 'Örn. Klima' }) || '').trim();
        if (!name) return;
        if (topicEntries.some(t => t.name.toLowerCase() === name.toLowerCase())) { toast('Bu konu zaten var.'); return; }
        if (window.IssueConfig) IssueConfig.addTopic(name).then(() => toast('Konu eklendi.')).catch(() => toast('Eklenemedi.', true));
    }
    function listenTopics() {
        if (!window.IssueConfig) return;
        IssueConfig.listenTopics(list => { topicEntries = list || []; renderTopics(); });
    }

    // ── Boot ───────────────────────────────────────────────────
    function boot() {
        // Feature-gated: if the hotel's plan doesn't include "Misafir Kayıtları"
        // (guestIssues), drop the admin tab entirely.
        if (typeof moduleEnabled === 'function' && !moduleEnabled('guestIssues')) {
            const tab = document.querySelector('.sb-link[data-view="issues"]');
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
        $('issTopicAddBtn') && ($('issTopicAddBtn').onclick = addTopicPrompt);
        const modal = $('issueModal');
        if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
        auth.onAuthStateChanged(u => { if (u) { listen(); listenTopics(); } });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
