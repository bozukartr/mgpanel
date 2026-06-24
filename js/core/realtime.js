/* StayOS — Realtime presence + in-app notifications + bell UI.
 *
 * Drop-in: include AFTER firebase-config.js on any authenticated page.
 *   <script src="realtime.js"></script>
 *
 * Provides window.RT:
 *   RT.getActiveUsers(excludeSelf)  -> Promise<[{uid, username, dept}]>
 *   RT.sendNotification({toUid,toUsername,title,body,recordId,type})
 *   RT.onNotifications(cb)          -> cb(list) on every change
 *   RT.markRead(id) / RT.markAllRead()
 *
 * Renders a bell into an element with id="rt-bell" if present; the dropdown,
 * toast and styles are injected so no extra CSS/markup is required per page.
 */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof auth === 'undefined' || typeof firebase === 'undefined') return;

    const TENANT = (typeof TENANT_ID !== 'undefined' && TENANT_ID) || localStorage.getItem('hotelTenantId') || 'mgallery';
    const USERNAME = localStorage.getItem('hotelUsername') || 'Kullanıcı';
    const DEPT = localStorage.getItem('hotelDept') || '';
    const ACTIVE_WINDOW_MS = 2 * 60 * 1000;   // "online" = heartbeat within 2 min
    const HEARTBEAT_MS = 45 * 1000;

    const RT = window.RT = window.RT || {};
    let uid = null;
    let notifications = [];
    let onNotifCb = null;
    let firstLoad = true;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function timeAgo(d) {
        if (!d) return '';
        const s = Math.floor((Date.now() - d) / 1000);
        if (s < 60) return 'az önce';
        const m = Math.floor(s / 60);
        if (m < 60) return m + ' dk önce';
        const h = Math.floor(m / 60);
        if (h < 24) return h + ' sa önce';
        return Math.floor(h / 24) + ' g önce';
    }

    // ── styles (injected once) ─────────────────────────────────
    function injectStyles() {
        if (document.getElementById('rt-styles')) return;
        const css = `
        #rt-bell { position: relative; }
        .rt-bell-btn {
            position: relative; width: 38px; height: 38px; border-radius: 10px;
            background: #f1f5f9; border: none; cursor: pointer; color: #475569;
            display: inline-flex; align-items: center; justify-content: center; transition: background .2s;
        }
        .rt-bell-btn:hover { background: #e2e8f0; color: #1e293b; }
        .rt-badge {
            position: absolute; top: -4px; right: -4px; min-width: 17px; height: 17px; padding: 0 4px;
            background: #ef4444; color: #fff; border-radius: 9px; font-size: 10px; font-weight: 800;
            display: none; align-items: center; justify-content: center; line-height: 1; font-family: 'Outfit', sans-serif;
        }
        .rt-badge.show { display: inline-flex; }
        .rt-panel {
            position: absolute; right: 0; top: calc(100% + 10px); width: 340px; max-width: 92vw;
            background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; box-shadow: 0 18px 50px rgba(15,23,42,.18);
            z-index: 4000; overflow: hidden; display: none; font-family: 'Outfit', sans-serif;
        }
        .rt-panel.show { display: block; animation: rtSlide .16s ease-out; }
        @keyframes rtSlide { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
        .rt-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #eef2f7; }
        .rt-panel-head b { font-size: 14px; color: #1e293b; }
        .rt-readall { background: none; border: none; color: #6366f1; font-size: 12px; font-weight: 600; cursor: pointer; }
        .rt-list { max-height: 380px; overflow-y: auto; }
        .rt-item { display: flex; gap: 11px; padding: 13px 16px; border-bottom: 1px solid #f4f7f9; cursor: pointer; transition: background .15s; }
        .rt-item:hover { background: #f8fafc; }
        .rt-item.unread { background: #f5f7ff; }
        .rt-item.unread:hover { background: #eef2ff; }
        .rt-ico { width: 34px; height: 34px; border-radius: 9px; background: #eef2ff; color: #6366f1; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 16px; }
        .rt-item-body { flex: 1; min-width: 0; }
        .rt-item-title { font-size: 13px; font-weight: 600; color: #1e293b; }
        .rt-item-text { font-size: 12px; color: #64748b; margin-top: 1px; word-break: break-word; }
        .rt-item-time { font-size: 11px; color: #94a3b8; margin-top: 3px; }
        .rt-dot { width: 8px; height: 8px; border-radius: 50%; background: #6366f1; flex-shrink: 0; margin-top: 6px; }
        .rt-empty { padding: 34px 16px; text-align: center; color: #94a3b8; font-size: 13px; }
        .rt-toast {
            position: fixed; top: 18px; left: 50%; transform: translateX(-50%) translateY(-120%);
            background: #1e293b; color: #fff; border-radius: 14px; padding: 12px 16px; z-index: 99999;
            box-shadow: 0 18px 50px rgba(15,23,42,.35); display: flex; gap: 12px; align-items: center;
            max-width: 92vw; width: 360px; transition: transform .35s cubic-bezier(.2,1,.3,1); font-family: 'Outfit', sans-serif;
            cursor: pointer; border: 1px solid rgba(255,255,255,.08);
        }
        .rt-toast.show { transform: translateX(-50%) translateY(0); }
        .rt-toast .rt-ico { background: rgba(99,102,241,.25); color: #c7d2fe; }
        .rt-toast b { font-size: 13.5px; display: block; }
        .rt-toast span { font-size: 12.5px; color: #cbd5e1; }
        @media (max-width: 600px) {
            .rt-toast { top: 12px; width: calc(100vw - 24px); }
            /* On phones the bell may sit anywhere in the header; anchoring the
               panel to the bell (right:0) pushed a 340px panel off the left edge.
               Pin it to the viewport instead so it always stays on-screen. JS
               sets a precise top from the bell's position. */
            .rt-panel { position: fixed; left: 12px; right: 12px; top: 62px; width: auto; max-width: none; }
        }`;
        const el = document.createElement('style');
        el.id = 'rt-styles';
        el.textContent = css;
        document.head.appendChild(el);
    }

    // ── bell + dropdown ────────────────────────────────────────
    let panelEl = null, badgeEl = null, listEl = null;
    function buildBell() {
        const mount = document.getElementById('rt-bell');
        if (!mount || mount.dataset.built) return;
        mount.dataset.built = '1';
        mount.innerHTML = `
            <button class="rt-bell-btn" id="rt-bell-btn" title="Bildirimler" aria-label="Bildirimler">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                <span class="rt-badge" id="rt-badge">0</span>
            </button>
            <div class="rt-panel" id="rt-panel">
                <div class="rt-panel-head"><b>Bildirimler</b><button class="rt-readall" id="rt-readall">Tümünü temizle</button></div>
                <div class="rt-list" id="rt-list"></div>
            </div>`;
        badgeEl = mount.querySelector('#rt-badge');
        panelEl = mount.querySelector('#rt-panel');
        listEl = mount.querySelector('#rt-list');
        mount.querySelector('#rt-bell-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            panelEl.classList.toggle('show');
            if (panelEl.classList.contains('show')) {
                positionPanel(mount);
                renderList();
            }
        });
        mount.querySelector('#rt-readall').addEventListener('click', (e) => { e.stopPropagation(); RT.markAllRead(); });
        document.addEventListener('click', (e) => { if (panelEl && !mount.contains(e.target)) panelEl.classList.remove('show'); });
        renderBadge();
    }

    // On phones, pin the panel to the viewport just below the bell (CSS handles
    // the left/right inset; here we set a precise top). On wider screens the
    // CSS absolute positioning applies, so clear any inline top.
    function positionPanel(mount) {
        if (!panelEl) return;
        if (window.innerWidth <= 600) {
            const btn = mount.querySelector('#rt-bell-btn');
            const r = btn ? btn.getBoundingClientRect() : null;
            panelEl.style.top = (r ? Math.round(r.bottom + 8) : 62) + 'px';
        } else {
            panelEl.style.top = '';
        }
    }

    function renderBadge() {
        const n = notifications.filter(x => !x.read).length;
        if (!badgeEl) return;
        badgeEl.textContent = n > 9 ? '9+' : n;
        badgeEl.classList.toggle('show', n > 0);
    }
    function renderList() {
        if (!listEl) return;
        if (!notifications.length) {
            listEl.innerHTML = `<div class="rt-empty">Henüz bildirim yok.</div>`;
            return;
        }
        listEl.innerHTML = notifications.slice(0, 40).map(n => {
            const t = n.createdAt && n.createdAt.toDate ? n.createdAt.toDate().getTime() : null;
            return `<div class="rt-item ${n.read ? '' : 'unread'}" data-id="${esc(n.id)}" data-record="${esc(n.recordId || '')}" data-type="${esc(n.type || '')}">
                <div class="rt-ico">${n.type === 'complaint' ? '⚠️' : '🔔'}</div>
                <div class="rt-item-body">
                    <div class="rt-item-title">${esc(n.title || 'Bildirim')}</div>
                    <div class="rt-item-text">${esc(n.body || '')}</div>
                    <div class="rt-item-time">${esc(timeAgo(t))}${n.fromUsername ? ' · ' + esc(n.fromUsername) : ''}</div>
                </div>
                ${n.read ? '' : '<span class="rt-dot"></span>'}</div>`;
        }).join('');
        listEl.querySelectorAll('.rt-item').forEach(it => {
            it.addEventListener('click', () => {
                const id = it.dataset.id, rec = it.dataset.record, type = it.dataset.type;
                RT.markRead(id);
                RT.openRecord(rec, type);
                if (panelEl) panelEl.classList.remove('show');
            });
        });
    }

    // ── toast for new notifications ────────────────────────────
    let toastEl = null, toastTimer = null;
    function showToast(n) {
        // App Shell iframe'i içinde gömülüyken bildirim toast'ını kabuk gösterir;
        // çift gösterimi önlemek için panel kopyası sessiz kalır (listener çalışmaya devam eder).
        if (window.__EMBED__) return;
        injectStyles();
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.className = 'rt-toast';
            document.body.appendChild(toastEl);
            toastEl.addEventListener('click', () => {
                toastEl.classList.remove('show');
                if (toastEl.dataset.id) RT.markRead(toastEl.dataset.id); // interaction → remove
                RT.openRecord(toastEl.dataset.record, toastEl.dataset.type);
            });
        }
        toastEl.dataset.id = n.id || '';
        toastEl.dataset.record = n.recordId || '';
        toastEl.dataset.type = n.type || '';
        toastEl.innerHTML = `<div class="rt-ico">${n.type === 'complaint' ? '⚠️' : '🔔'}</div>
            <div><b>${esc(n.title || 'Yeni bildirim')}</b><span>${esc(n.body || '')}</span></div>`;
        requestAnimationFrame(() => toastEl.classList.add('show'));
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('show'), 6000);
        try { if (navigator.vibrate) navigator.vibrate([60, 40, 60]); } catch (e) { }
    }

    // ── public API ─────────────────────────────────────────────
    RT.onNotifications = (cb) => { onNotifCb = cb; cb(notifications); };
    RT.getActiveUsers = async function (excludeSelf) {
        const cutoff = Date.now() - ACTIVE_WINDOW_MS;
        const out = [];
        try {
            const snap = await db.collection('presence').where('tenantId', '==', TENANT).get();
            snap.forEach(d => {
                const u = d.data();
                const ls = u.lastSeen && u.lastSeen.toDate ? u.lastSeen.toDate().getTime() : 0;
                if (u.online !== false && ls >= cutoff) {
                    if (excludeSelf !== false && d.id === uid) return;
                    out.push({ uid: d.id, username: u.username || d.id, dept: u.dept || '' });
                }
            });
        } catch (e) { /* ignore */ }
        out.sort((a, b) => (a.username || '').localeCompare(b.username || '', 'tr'));
        return out;
    };
    RT.sendNotification = async function (opts) {
        opts = opts || {};
        if (!opts.toUid || !uid) return;
        await db.collection('notifications').add({
            tenantId: TENANT,
            toUid: opts.toUid,
            toUsername: opts.toUsername || '',
            fromUid: uid,
            fromUsername: USERNAME,
            title: opts.title || 'Yeni talep',
            body: opts.body || '',
            recordId: opts.recordId || '',
            type: opts.type || 'request',
            read: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    };
    // Per-type openers let a page handle its own notifications inline (e.g. the
    // Concierge guest-orders drawer) instead of navigating to the panel.
    RT.openers = RT.openers || {};
    RT.registerOpener = function (type, fn) { if (type && typeof fn === 'function') RT.openers[type] = fn; };

    // Opens the record referenced by a notification. A registered opener for the
    // notification's type wins; otherwise pages that show requests
    // (panel.html) override RT.onOpen; otherwise we navigate there.
    RT.openRecord = function (recordId, type) {
        if (type && RT.openers[type]) { RT.openers[type](recordId); return; }
        // Guest-order notifications live in the Concierge drawer; from any other
        // page, jump there and let it focus the order via ?order=.
        if (type === 'guestOrder') {
            if (recordId) window.location.href = 'concierge.html?order=' + encodeURIComponent(recordId);
            return;
        }
        if (typeof RT.onOpen === 'function') { RT.onOpen(recordId); return; }
        if (!recordId) return;
        const target = 'panel.html?open=' + encodeURIComponent(recordId);
        window.location.href = target;
    };
    // Notifications are removed once read / interacted with (no read-archive).
    RT.markRead = async function (id) { try { await db.collection('notifications').doc(id).delete(); } catch (e) { } };
    RT.markAllRead = async function () {
        if (!notifications.length) return;
        const batch = db.batch();
        notifications.forEach(n => batch.delete(db.collection('notifications').doc(n.id)));
        try { await batch.commit(); } catch (e) { }
    };

    // ── presence heartbeat ─────────────────────────────────────
    function startPresence() {
        const ref = db.collection('presence').doc(uid);
        const beat = () => ref.set({
            uid, username: USERNAME, dept: DEPT, tenantId: TENANT,
            online: true, lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => { });
        beat();
        setInterval(() => { if (!document.hidden) beat(); }, HEARTBEAT_MS);
        window.addEventListener('focus', beat);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
        window.addEventListener('beforeunload', () => {
            try { ref.set({ online: false, lastSeen: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch (e) { }
        });
    }

    // ── notifications listener ─────────────────────────────────
    function listenNotifications() {
        db.collection('notifications').where('toUid', '==', uid).onSnapshot(snap => {
            notifications = snap.docs.map(d => Object.assign({ id: d.id }, d.data()))
                .sort((a, b) => ((b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) - (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0)));
            if (!firstLoad) {
                snap.docChanges().forEach(ch => {
                    if (ch.type === 'added') {
                        const n = ch.doc.data();
                        if (!n.read) showToast(n);
                    }
                });
            }
            firstLoad = false;
            renderBadge();
            if (panelEl && panelEl.classList.contains('show')) renderList();
            if (onNotifCb) onNotifCb(notifications);
        }, () => { });
    }

    // ── boot ───────────────────────────────────────────────────
    function boot() {
        injectStyles();
        buildBell();
        auth.onAuthStateChanged(u => {
            if (!u || uid) return;
            uid = u.uid;
            startPresence();
            listenNotifications();
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
