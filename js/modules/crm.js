function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Maintenance enforcement — also runs here so it works even if a cached page
// didn't load the guard script.
(function () {
    if (typeof db === 'undefined') return;
    db.collection('maintenance').doc(guardTenant()).onSnapshot((doc) => {
        if (!doc.exists) return;
        const d = doc.data();
        const ends = d.endsAt && d.endsAt.toDate ? d.endsAt.toDate() : null;
        if (d.enabled && ends && ends > new Date()) window.location.replace('maintenance');
    }, function () {});
})();

document.addEventListener('DOMContentLoaded', () => {
    // ── AUTH & INIT ───────────────────────────────────────────
    const userNameDisplay = document.getElementById('userNameDisplay');
    const loggedUsername = localStorage.getItem('hotelUsername') || 'Admin';
    const loggedRole = (localStorage.getItem('hotelRole') || '').toLowerCase();
    let isAdminUser = loggedRole === 'admin' || loggedUsername.toLowerCase() === 'admin';
    if (userNameDisplay) userNameDisplay.textContent = loggedUsername;

    auth.onAuthStateChanged(async (user) => {
        if (!user) { window.location.href = 'login'; return; }
        // Confirm admin from Firestore (source of truth) and reveal the Admin link.
        try {
            const doc = await db.collection('systemUsers').doc(user.uid).get();
            if (doc.exists) {
                const data = doc.data();
                if (data.role) localStorage.setItem('hotelRole', data.role);
                const role = (data.role || '').toLowerCase();
                const uname = (data.username || '').toLowerCase();
                if (role === 'admin' || uname === 'admin') isAdminUser = true;
            }
        } catch (e) { console.error('Auth check failed', e); }

        if (isAdminUser) {
            const adminLink = document.getElementById('adminLink');
            if (adminLink) adminLink.style.display = 'inline-block';
            const adminNavMobile = document.getElementById('crmAdminNavMobile');
            if (adminNavMobile) adminNavMobile.style.display = 'flex';
        }
    });

    document.getElementById('logoutBtn')?.addEventListener('click', () => {
        auth.signOut().then(() => {
            clearSessionStorage();
            window.location.href = 'login';
        });
    });

    // ── DATA STATE ─────────────────────────────────────────────
    let guestDirectory = [];
    let guestLogs = [];
    let reservations = [];
    let currentGuestId = null;
    let filterStatus = 'arrival';
    let timelineFilter = 'all';

    // ── CORE FUNCTIONS ─────────────────────────────────────────
    // Misafir aktivitesi (guestLogs + reservations) yalnızca bir misafir detayı
    // ya da birleştirme/uzlaştırma açıldığında gerekir. Bu iki koleksiyon zamanla
    // sınırsız büyüdüğünden, her CRM açılışında/işleminde değil yalnızca talep
    // üzerine bir kez yüklenir. İsim eşleştirmesi büyük/küçük harf duyarsız
    // olduğundan (hedefli sunucu sorgusu kayıtları atlayabilir) tam yükleme korunur.
    let activityLoaded = false;
    let activityLoadedAt = 0;
    // "Bir kez yükle" önbelleği süresiz kalırsa (activityLoaded hiç sıfırlanmaz),
    // CRM açık bırakılan bir vardiyada başka bir modülün (panel.js/concierge.js)
    // eklediği yeni log/rezervasyon hiç görünmez — bayat veri kalıcı olur. TTL
    // ile periyodik tazeleme, tam canlı streaming maliyetine girmeden bunu giderir.
    const ACTIVITY_TTL_MS = 3 * 60 * 1000;
    const ensureGuestActivity = async () => {
        if (activityLoaded && (Date.now() - activityLoadedAt) < ACTIVITY_TTL_MS) return;
        const logsSnap = await db.collection('guestLogs').where('tenantId', '==', TENANT_ID).get();
        guestLogs = logsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const resSnap = await db.collection('reservations').where('tenantId', '==', TENANT_ID).get();
        reservations = resSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        activityLoaded = true;
        activityLoadedAt = Date.now();
    };

    // Yalnızca misafir rehberini (liste için yeterli) yükler.
    const loadDirectory = async () => {
        try {
            const dirSnap = await db.collection('guestDirectory').where('tenantId', '==', TENANT_ID).get();
            guestDirectory = dirSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            // Auto Check-Out past guests
            const today = new Date().toISOString().split('T')[0];
            const batch = db.batch();
            let needsCommit = false;
            const staysToClose = [];

            guestDirectory.forEach(g => {
                if (g.status === 'in_house' && g.checkOut && g.checkOut < today) {
                    batch.update(db.collection('guestDirectory').doc(g.id), { status: 'checked_out' });
                    g.status = 'checked_out'; // Update local state immediately
                    if (g.activeStayId) staysToClose.push({ id: g.id, activeStayId: g.activeStayId });
                    needsCommit = true;
                }
            });

            if (needsCommit) {
                await batch.commit();
                // Konaklamayı da kapat (stays tarafı — kimlik migrasyonu).
                for (const g of staysToClose) { await GuestDirectory.closeStay(g, 'auto-checkout'); }
                console.log("Auto-checkout executed for past guests.");
            }

            renderGuestList();
            if (currentGuestId) viewGuestDetail(currentGuestId);
        } catch (e) {
            console.error("Data load failed", e);
            showToast("Failed to sync data", true);
        }
    };
    // Geriye dönük uyum: eski çağrı adı rehberi yükler.
    const loadAllData = loadDirectory;


    const generateTags = (logs, res) => {
        const tags = [];
        if (res.length > 2) tags.push('Sadık Misafir');
        if (logs.length > 3) tags.push('Sık Talep');
        if (res.some(r => r.serviceType === 'VIP')) tags.push('VIP');
        if (logs.some(l => l.complaint?.toLowerCase().includes('birthday'))) tags.push('Özel Gün');
        return tags;
    };

    const renderGuestList = () => {
        const listEl = document.getElementById('guestList');
        const search = document.getElementById('guestSearch').value.toLowerCase();
        
        const searching = search.trim() !== '';
        let filtered = guestDirectory.filter(g => {
            const matchesSearch = g.name.toLowerCase().includes(search) || (g.room && g.room.includes(search));

            // Global search: while typing, match across ALL statuses (bekleyen /
            // konaklayan / çıkış yapmış) regardless of the active filter tab.
            if (searching) return matchesSearch;

            let matchesStatus = false;
            if (filterStatus === 'arrival') {
                matchesStatus = g.status === 'pre_arrival';
            } else {
                matchesStatus = g.status === filterStatus;
            }
            return matchesSearch && matchesStatus;
        });

        // Sort by lastUpdated or status
        filtered.sort((a,b) => (b.lastUpdated || '').localeCompare(a.lastUpdated || ''));

        listEl.innerHTML = filtered.map(g => {
            const missingDates = (g.status === 'in_house' || g.status === 'pre_arrival') && (!g.checkIn || !g.checkOut);
            const dateAlert = missingDates ? `<span style="font-size:9px; background:#ef4444; color:white; padding:2px 6px; border-radius:4px; margin-left:8px; font-weight:bold;">Tarih Eksik</span>` : '';
            return `
            <div class="guest-card ${currentGuestId === g.id ? 'active' : ''} ${missingDates ? 'missing-dates' : ''}" onclick="viewGuestDetail('${g.id}')">
                <div class="guest-card-header">
                    <span class="guest-card-name">${esc(g.name)}${dateAlert}</span>
                    <span class="guest-card-status ${g.status === 'in_house' ? 'status-in-house' : (g.status === 'pre_arrival' ? 'status-arrival' : 'status-checked-out')}">
                        ${g.status === 'in_house' ? 'Konaklayan' : (g.status === 'pre_arrival' ? 'Bekleyen' : 'Çıkış yaptı')}
                    </span>
                </div>
                <div class="guest-card-room">Oda: ${esc(g.room || '—')}</div>
            </div>
        `}).join('');
    };

    window.viewGuestDetail = async (guestId) => {
        currentGuestId = guestId;
        const guest = guestDirectory.find(g => g.id === guestId);
        if (!guest) return;

        await ensureGuestActivity(); // detay zaman çizelgesi/etiketleri için aktiviteyi yükle

        // Render Active Card
        const cards = document.querySelectorAll('.guest-card');
        cards.forEach(c => c.classList.remove('active'));
        const activeCard = Array.from(cards).find(c => c.querySelector('.guest-card-name')?.textContent === guest.name);
        if (activeCard) activeCard.classList.add('active');

        const detailEl = document.getElementById('guestDetail');
        
        const guestNameLower = (guest.name || '').toLocaleLowerCase('tr-TR');
        const gLogs = guestLogs.filter(l => (l.guestName || '').toLocaleLowerCase('tr-TR') === guestNameLower);
        const gRes = reservations.filter(r => (r.guestName || '').toLocaleLowerCase('tr-TR') === guestNameLower);
        
        const tags = generateTags(gLogs, gRes);

        const interactions = [
            ...gLogs.map(l => ({ ...l, interactionType: 'issue', sortDate: l.createdAt ? (l.createdAt.toDate ? l.createdAt.toDate() : new Date(l.createdAt)) : new Date(l.date) })),
            ...gRes.map(r => ({ ...r, interactionType: 'concierge', sortDate: r.createdAt ? (r.createdAt.toDate ? r.createdAt.toDate() : new Date(r.createdAt)) : new Date(r.date) }))
        ];

        interactions.sort((a,b) => b.sortDate - a.sortDate);

        const filteredInteractions = interactions.filter(i => {
            if (timelineFilter === 'all') return true;
            if (timelineFilter === 'issues') return i.interactionType === 'issue';
            if (timelineFilter === 'concierge') return i.interactionType === 'concierge';
            return true;
        });

        detailEl.innerHTML = `
            <div class="profile-header">
                <div class="profile-main-info">
                    <h1>${esc(guest.name)}</h1>
                    <div class="guest-tags" style="margin: 8px 0;">
                        ${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
                    </div>
                    <div class="profile-room-badge">
                        Oda ${esc(guest.room || '—')} • Güncellendi ${new Date(guest.lastUpdated).toLocaleDateString('tr-TR')}
                        ${guest.checkIn ? `<br><span style="color:#2563eb; font-weight:600;">Giriş: ${esc(guest.checkIn)}</span>` : ''}
                        ${guest.checkOut ? ` <span style="color:#e11d48; font-weight:600; margin-left:10px;">Çıkış: ${esc(guest.checkOut)}</span>` : ''}
                    </div>
                </div>
                <div class="profile-actions" style="display: flex; gap: 8px;">
                    <button class="btn-status-toggle" style="background-color: #f59e0b; color: white;"
                            onclick="openRoomChangeModal('${guest.id}')">
                        Bilgileri Düzenle
                    </button>
                    ${guest.status === 'pre_arrival' ? `
                    <button class="btn-status-toggle btn-in-house" onclick="toggleStatus('${guest.id}', 'in_house')">
                        Giriş Yap
                    </button>
                    ` : `
                    <button class="btn-status-toggle ${guest.status === 'in_house' ? 'btn-checked-out' : 'btn-in-house'}"
                            onclick="toggleStatus('${guest.id}', '${guest.status === 'in_house' ? 'checked_out' : 'in_house'}')">
                        ${guest.status === 'in_house' ? 'Çıkış Yap' : 'Giriş Yap'}
                    </button>
                    `}
                    ${isAdminUser ? `
                    <button class="btn-status-toggle" style="background-color: #7c3aed; color: white;"
                            onclick="openMergeModal('${guest.id}')">
                        Birleştir
                    </button>
                    <button class="btn-status-toggle" style="background-color: #ef4444; color: white;"
                            onclick="deleteGuest('${guest.id}')">
                        Sil
                    </button>
                    ` : ''}
                </div>
            </div>

            <div class="guest-notes-area">
                <div class="notes-header">
                    <span>Personel Notları & Tercihler</span>
                    <span style="opacity:0.6; font-size:10px;">Otomatik kaydediliyor...</span>
                </div>
                <div class="notes-content">
                    <textarea id="guestNotesInput" placeholder="Tercih, alerji veya özel istekleri ekleyin..."
                              oninput="updateGuestNotes('${guest.id}', this.value)">${esc(guest.notes || '')}</textarea>
                </div>
            </div>

            <div class="profile-grid">
                <div class="info-card">
                    <label>Toplam Etkileşim</label>
                    <div class="val">${interactions.length}</div>
                </div>
                <div class="info-card">
                    <label>Çözüm Oranı</label>
                    <div class="val">${gLogs.length === 0 ? '100%' : Math.round((gLogs.filter(l => l.status === 'Solved').length / gLogs.length) * 100) + '%'}</div>
                </div>
                <div class="info-card">
                    <label>Durum</label>
                    <div class="val" style="color:${guest.status === 'in_house' ? '#10b981' : '#64748b'}">${guest.status === 'in_house' ? 'KONAKLIYOR' : 'ÇIKIŞ YAPTI'}</div>
                </div>
            </div>

            <div class="interaction-history">
                <div class="detail-tabs">
                    <button class="tab-link ${timelineFilter === 'all' ? 'active' : ''}" onclick="setTimelineFilter('all')">Tümü</button>
                    <button class="tab-link ${timelineFilter === 'issues' ? 'active' : ''}" onclick="setTimelineFilter('issues')">Talepler</button>
                    <button class="tab-link ${timelineFilter === 'concierge' ? 'active' : ''}" onclick="setTimelineFilter('concierge')">Concierge</button>
                </div>
                
                <div class="history-timeline">
                    ${filteredInteractions.length === 0 ? '<p style="color:#888; padding:20px;">Bu kategoride kayıt yok.</p>' : filteredInteractions.map(i => {
                        const isIssue = i.interactionType === 'issue';
                        const title = isIssue ? i.complaint : `${i.type} Rezervasyon ${i.resName || i.vehicle || i.vessel || ''}`;
                        const desc = isIssue ? (i.solution || '') : (i.notes || '');

                        return `
                            <div class="timeline-item ${isIssue ? 'issue' : 'concierge'}">
                                <div class="item-header">
                                    <span class="item-type type-${isIssue ? 'issue' : 'concierge'}">${isIssue ? 'Kayıt' : 'Concierge'}</span>
                                    <span class="item-date">${new Date(i.sortDate).toLocaleDateString('tr-TR')}</span>
                                </div>
                                <div class="item-title">${esc(title)}</div>
                                <div class="item-desc">${esc(desc)}</div>
                                <div style="font-size:11px; color:#94a3b8; margin-top:8px;">
                                    ${isIssue ? `Departman: ${esc(i.department)} • Personel: ${esc(i.staffInitial)}` : `Saat: ${esc(i.time || '—')} • Durum: ${esc(i.status)} • Personel: ${esc(i.staffInitial)}`}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    };

    window.setTimelineFilter = (filter) => {
        timelineFilter = filter;
        if (currentGuestId) viewGuestDetail(currentGuestId);
    };

    let notesTimeout;
    window.updateGuestNotes = (guestId, val) => {
        clearTimeout(notesTimeout);
        notesTimeout = setTimeout(async () => {
            try {
                await db.collection('guestDirectory').doc(guestId).update({ notes: val });
                const guest = guestDirectory.find(g => g.id === guestId);
                if (guest) guest.notes = val;
            } catch (e) { console.error("Notes save failed", e); }
        }, 1000);
    };

    window.toggleStatus = async (guestId, newStatus) => {
        try {
            await db.collection('guestDirectory').doc(guestId).update({
                status: newStatus,
                lastUpdated: new Date().toISOString()
            });
            // Konaklama (stays) tarafını tutarlı tut: checkout aktif
            // konaklamayı kapatır; in_house'a dönüş yeni bir konaklama açar
            // (önceki tarihçede kalır) — kimlik migrasyonu.
            const guest = guestDirectory.find(g => g.id === guestId);
            if (guest) {
                if (newStatus === 'checked_out') {
                    await GuestDirectory.closeStay(guest, loggedUsername);
                } else if (newStatus === 'in_house') {
                    await GuestDirectory.syncGuestStatus(guest.name, { guestId: guest.id, room: guest.room, status: 'in_house' });
                }
            }
            showToast(`Guest status updated: ${newStatus.replace('_',' ')}`);
            loadAllData();
        } catch (e) { showToast('Update failed', true); }
    };

    window.deleteGuest = async (guestId) => {
        if (!isAdminUser) {
            return showToast('Only Admin can delete guests!', true);
        }
        // guestName her zaman guestDirectory'deki (zaten yüklü, güvenilir) kayıttan
        // okunur — onclick attribute'una serbest metin gömülmez (bkz. güvenlik
        // denetimi: misafir adının onclick içine ham/eksik-escape edilmiş şekilde
        // yerleştirilmesi stored XSS'e yol açıyordu).
        const guest = guestDirectory.find(g => g.id === guestId);
        const guestName = guest ? guest.name : guestId;

        if (!confirm(`Are you sure you want to permanently delete the profile for ${guestName}?\n\nWarning: This removes the guest from the directory, but keeps their historical logs intact.`)) {
            return;
        }

        try {
            await db.collection('guestDirectory').doc(guestId).delete();
            showToast(`Guest ${guestName} deleted successfully.`);
            currentGuestId = null;
            document.getElementById('guestDetail').innerHTML = `
                <div class="empty-state" style="display:flex;">
                    <p>Select a guest to view details</p>
                </div>
            `;
            loadAllData();
        } catch (e) {
            console.error("Delete failed", e);
            showToast('Delete failed. Check permissions.', true);
        }
    };

    // ── MERGE GUESTS ───────────────────────────────────────────
    let mergePrimaryId = null;

    function populateMergeOptions(search) {
        const sel = document.getElementById('mergeSelect');
        if (!sel) return;
        const s = (search || '').toLowerCase();
        const opts = guestDirectory
            .filter(g => g.id !== mergePrimaryId)
            .filter(g => !s || g.name.toLowerCase().includes(s) || (g.room && g.room.toLowerCase().includes(s)))
            .sort((a, b) => a.name.localeCompare(b.name));
        const statusLabel = (st) => st === 'in_house' ? 'Konaklayan' : (st === 'pre_arrival' ? 'Bekleyen' : 'Çıkış yaptı');
        sel.innerHTML = opts.map(g =>
            `<option value="${g.id}">${esc(g.name)} — ${esc(g.room || '—')} (${statusLabel(g.status)})</option>`
        ).join('');
    }

    window.openMergeModal = (primaryId) => {
        if (!isAdminUser) return showToast('Only Admin can merge guests!', true);
        const primary = guestDirectory.find(g => g.id === primaryId);
        if (!primary) return;
        mergePrimaryId = primaryId;
        document.getElementById('mergePrimaryName').textContent = primary.name;
        document.getElementById('mergeSearch').value = '';
        populateMergeOptions('');
        const modal = document.getElementById('mergeModal');
        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
    };

    window.closeMergeModal = () => {
        document.getElementById('mergeModal').style.display = 'none';
        mergePrimaryId = null;
    };

    window.submitMerge = async () => {
        if (!isAdminUser) return showToast('Only Admin can merge guests!', true);
        const secondaryId = document.getElementById('mergeSelect').value;
        if (!mergePrimaryId || !secondaryId) return showToast('Select a duplicate guest to merge.', true);
        if (secondaryId === mergePrimaryId) return showToast('Cannot merge a guest into itself.', true);

        const primary = guestDirectory.find(g => g.id === mergePrimaryId);
        const secondary = guestDirectory.find(g => g.id === secondaryId);
        if (!primary || !secondary) return showToast('Guest not found.', true);

        if (!confirm(`Merge "${secondary.name}" into "${primary.name}"?\n\nAll of "${secondary.name}"'s reservations, logs and notes will be transferred to "${primary.name}", and the duplicate profile will be deleted. This cannot be undone.`)) {
            return;
        }

        const btn = document.querySelector('#mergeModal button:last-child');
        const originalText = btn.textContent;
        btn.textContent = 'Merging...';
        btn.disabled = true;

        try {
            await ensureGuestActivity(); // birleştirilecek kayıtları okumak için aktivite gerekir
            const secName = secondary.name.toLowerCase();

            // Reassign the duplicate's reservations + logs to the primary name.
            // Uzun süredir konaklayan/çok talepli bir misafirde bu ikisinin
            // toplamı 500 işlemlik batch limitini aşabilir — tek batch bu
            // durumda TÜMÜYLE reddedilirdi (merge "başarılı" görünüp hiçbir
            // kayıt taşınmazdı). 450'lik parçalara bölünerek sırayla commit edilir.
            const ops = [];
            // Hem legacy isim eşleşmesi hem guestId eşleşmesi taşınır — kimlik
            // migrasyonu sonrası kayıtlar isimle değil guestId ile bağlı.
            reservations
                .filter(r => (r.guestName && r.guestName.toLowerCase() === secName) || r.guestId === secondary.id)
                .forEach(r => ops.push(b => b.update(db.collection('reservations').doc(r.id), { guestName: primary.name, guestId: primary.id })));
            guestLogs
                .filter(l => (l.guestName && l.guestName.toLowerCase() === secName) || l.guestId === secondary.id)
                .forEach(l => ops.push(b => b.update(db.collection('guestLogs').doc(l.id), { guestName: primary.name, guestId: primary.id })));
            // Mükerrer profilin konaklamaları da birincil misafire taşınır.
            try {
                const staySnap = await db.collection('stays')
                    .where('tenantId', '==', TENANT_ID).where('guestId', '==', secondary.id).get();
                staySnap.docs.forEach(d => ops.push(b => b.update(db.collection('stays').doc(d.id), { guestId: primary.id, guestName: primary.name })));
            } catch (e) { console.error('stay merge read failed', e); }

            // Merge notes
            const primaryNotes = (primary.notes || '').trim();
            const secondaryNotes = (secondary.notes || '').trim();
            let mergedNotes = primaryNotes;
            if (secondaryNotes && !primaryNotes.includes(secondaryNotes)) {
                mergedNotes = primaryNotes
                    ? `${primaryNotes}\n\n[Merged from ${secondary.name}]\n${secondaryNotes}`
                    : secondaryNotes;
            }

            const CHUNK = 450;
            for (let i = 0; i < ops.length; i += CHUNK) {
                const b = db.batch();
                ops.slice(i, i + CHUNK).forEach(applyOp => applyOp(b));
                await b.commit();
            }

            const finalBatch = db.batch();
            const primaryUpd = {
                notes: mergedNotes,
                lastUpdated: new Date().toISOString()
            };
            // Birincil profilin aktif konaklaması yoksa mükerrer profilinki devralınır.
            if (!primary.activeStayId && secondary.activeStayId) primaryUpd.activeStayId = secondary.activeStayId;
            finalBatch.update(db.collection('guestDirectory').doc(primary.id), primaryUpd);
            // Remove the duplicate profile
            finalBatch.delete(db.collection('guestDirectory').doc(secondary.id));
            await finalBatch.commit();

            showToast(`Merged "${secondary.name}" into "${primary.name}".`);
            closeMergeModal();
            currentGuestId = primary.id;
            activityLoaded = false; // isimler değişti → aktiviteyi tazele
            await loadDirectory();
        } catch (e) {
            console.error('Merge failed', e);
            showToast('Merge failed. Check permissions.', true);
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    };

    // ── EVENT LISTENERS ────────────────────────────────────────
    document.getElementById('mergeSearch')?.addEventListener('input', (e) => populateMergeOptions(e.target.value));
    document.getElementById('guestSearch')?.addEventListener('input', renderGuestList);

    // ── Manual guest add (works without a PMS) ─────────────────
    const addGuestModal = document.getElementById('addGuestModal');
    const openAddGuest = () => {
        ['agName', 'agRoom', 'agCheckIn', 'agCheckOut'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        document.getElementById('agStatus').value = 'in_house';
        addGuestModal.style.display = 'block';
        setTimeout(() => document.getElementById('agName')?.focus(), 80);
    };
    const closeAddGuest = () => { addGuestModal.style.display = 'none'; };
    document.getElementById('addGuestBtn')?.addEventListener('click', openAddGuest);
    document.getElementById('agCancel')?.addEventListener('click', closeAddGuest);
    addGuestModal?.addEventListener('click', (e) => { if (e.target === addGuestModal) closeAddGuest(); });
    ['agCheckIn', 'agCheckOut'].forEach(id => {
        document.getElementById(id)?.addEventListener('blur', (e) => { e.target.value = smartExpandDate(e.target.value.trim()); });
    });
    document.getElementById('agSave')?.addEventListener('click', async () => {
        const name = document.getElementById('agName').value.trim();
        const status = document.getElementById('agStatus').value;
        const room = document.getElementById('agRoom').value.trim();
        const checkIn = toIsoDate(smartExpandDate(document.getElementById('agCheckIn').value.trim()));
        const checkOut = toIsoDate(smartExpandDate(document.getElementById('agCheckOut').value.trim()));
        if (!name) return showToast('Lütfen misafir adını girin.', true);
        if (status === 'in_house' && !room) return showToast('In House için oda numarası gerekli.', true);
        const dup = guestDirectory.find(g => (g.name || '').toLowerCase() === name.toLowerCase() && g.status !== 'checked_out');
        if (dup && !confirm(`"${name}" zaten kayıtlı görünüyor. Yine de yeni kayıt eklensin mi?`)) return;
        const btn = document.getElementById('agSave');
        btn.textContent = 'Kaydediliyor...'; btn.disabled = true;
        try {
            // Oda çakışması: aynı odada, farklı isimde HÂLÂ konaklayan (in_house)
            // başka bir misafir var mı — önceden hiç kontrol edilmiyordu, iki
            // resepsiyonist eşzamanlı olarak aynı odayı iki farklı misafire
            // atayabiliyordu (bkz. tutarlılık denetimi). Yerel önbellek yerine
            // taze bir sunucu okuması kullanılır.
            if (status === 'in_house' && room) {
                const roomKey = room.toLowerCase();
                const snap = await db.collection('guestDirectory')
                    .where('tenantId', '==', TENANT_ID).where('status', '==', 'in_house').get();
                const occupant = snap.docs.map(d => d.data())
                    .find(g => (g.room || '').trim().toLowerCase() === roomKey && (g.name || '').toLowerCase() !== name.toLowerCase());
                if (occupant && !confirm(`Oda ${room} şu anda "${occupant.name}" adına dolu görünüyor.\n\nYine de bu odayı "${name}" için de kaydetmek istiyor musunuz?`)) {
                    btn.textContent = 'Kaydet'; btn.disabled = false;
                    return;
                }
            }
            const newGuestRef = await db.collection('guestDirectory').add({
                name: name,
                room: status === 'pre_arrival' ? (room || '') : room,
                status: status,
                checkIn: checkIn || '',
                checkOut: checkOut || '',
                tenantId: TENANT_ID,
                lastUpdated: new Date().toISOString()
            });
            // Konaklama gerektiren durumlar için stays kaydı aç (kimlik
            // migrasyonu) — guestId'yi açıkça geçerek isim eşleştirmesine
            // (ve yukarıdaki onaylanmış mükerrer isim senaryosunda YANLIŞ
            // misafire yazmaya) hiç girmez.
            if (status === 'in_house' || status === 'pre_arrival') {
                try {
                    await GuestDirectory.syncGuestStatus(name, {
                        guestId: newGuestRef.id, room: room, status: status,
                        checkIn: checkIn || '', checkOut: checkOut || ''
                    });
                } catch (e2) { console.error('stay create failed', e2); }
            }
            closeAddGuest();
            showToast('Misafir eklendi.');
            await loadAllData();
        } catch (e) {
            console.error('add guest failed', e);
            showToast('Misafir eklenemedi.', true);
        } finally {
            btn.textContent = 'Kaydet'; btn.disabled = false;
        }
    });
    
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filterStatus = btn.dataset.filter;
            renderGuestList();
        });
    });

    const showToast = (msg, isError = false) => {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        t.style.background = isError ? '#ef4444' : '#1a1a1a';
        setTimeout(() => t.classList.remove('show'), 3000);
    };

    loadAllData();

    // ── SMART DATE EXPANSION ──
    const toIsoDate = (val) => {
        if (!val) return '';
        const p = val.split('/');
        if (p.length === 3) return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
        return val;
    };
    const toDisplayDate = (iso) => {
        if (!iso) return '';
        const p = iso.split('-');
        if (p.length === 3) return `${p[2]}/${p[1]}/${p[0]}`;
        return iso;
    };
    const smartExpandDate = (input) => {
        if (!input) return '';
        let v = input.replace(/\D/g, ''); 
        
        if (input.includes('.')) {
            const parts = input.split('.');
            if (parts.length >= 2) {
                const dd = parts[0].padStart(2, '0');
                const mm = parts[1].padStart(2, '0');
                let yy = new Date().getFullYear();
                if (parts[2]) yy = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
                return `${dd}/${mm}/${yy}`;
            }
        }

        if (v.length === 8) return `${v.slice(0,2)}/${v.slice(2,4)}/${v.slice(4)}`; 
        if (v.length === 6) return `${v.slice(0,2)}/${v.slice(2,4)}/20${v.slice(4)}`; 
        if (v.length === 4) return `0${v[0]}/0${v[1]}/20${v.slice(2)}`; 
        if (v.length === 5) { 
            if (parseInt(v.slice(0,2)) > 12) return `${v.slice(0,2)}/0${v.slice(2,3)}/20${v.slice(3)}`; 
            return `0${v.slice(0,1)}/${v.slice(1,3)}/20${v.slice(3)}`; 
        }
        return input;
    };

    ['rcCheckIn', 'rcCheckOut'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('blur', (e) => {
                e.target.value = smartExpandDate(e.target.value.trim());
            });
        }
    });

    // Room Change Logic
    let rcGuestId = null;
    let rcGuestName = null;

    window.openRoomChangeModal = (id) => {
        // Tüm alanlar guestDirectory'deki (zaten yüklü, güvenilir) kayıttan
        // okunur — onclick attribute'una serbest metin (misafir adı vb.)
        // gömülmez (bkz. güvenlik denetimi: bu daha önce escape edilmeden
        // veya yetersiz escape ile onclick içine yazılıyordu, stored XSS).
        const guest = guestDirectory.find(g => g.id === id);
        if (!guest) return;
        const name = guest.name, currentRoom = guest.room === 'Pre-Arrival' ? '' : (guest.room || '');
        const checkIn = guest.checkIn || '', checkOut = guest.checkOut || '', status = guest.status;

        rcGuestId = id;
        rcGuestName = name;
        document.getElementById('rcGuestName').textContent = name;
        document.getElementById('rcGuestNameInput').value = name;
        document.getElementById('rcNewRoom').value = currentRoom;
        document.getElementById('rcCheckIn').value = toDisplayDate(checkIn) || '';
        document.getElementById('rcCheckOut').value = toDisplayDate(checkOut) || '';

        const isPreArrivalBox = document.getElementById('rcIsPreArrival');
        if (isPreArrivalBox) {
            isPreArrivalBox.checked = (status === 'pre_arrival');
            document.getElementById('rcNewRoom').disabled = isPreArrivalBox.checked;
        }

        document.getElementById('roomChangeModal').style.display = 'flex';
        document.getElementById('roomChangeModal').style.alignItems = 'center';
        document.getElementById('roomChangeModal').style.justifyContent = 'center';
    };

    window.closeRoomChangeModal = () => {
        document.getElementById('roomChangeModal').style.display = 'none';
        rcGuestId = null;
        rcGuestName = null;
    };

    window.submitRoomChange = async () => {
        const isPreArrivalBox = document.getElementById('rcIsPreArrival');
        const isPreArrival = isPreArrivalBox ? isPreArrivalBox.checked : false;
        const newRoomRaw = document.getElementById('rcNewRoom').value.trim();
        const newName = document.getElementById('rcGuestNameInput').value.trim();

        const rawCheckIn = document.getElementById('rcCheckIn').value.trim();
        const rawCheckOut = document.getElementById('rcCheckOut').value.trim();

        const checkInDate = toIsoDate(smartExpandDate(rawCheckIn));
        const checkOutDate = toIsoDate(smartExpandDate(rawCheckOut));

        if (!isPreArrival && !newRoomRaw) return showToast('Please enter a room number.', true);
        if (!newName) return showToast('Please enter a guest name.', true);
        if (!rcGuestId || !rcGuestName) return;

        const nameChanged = newName !== rcGuestName;

        const newRoomForDir = isPreArrival ? '' : newRoomRaw;
        const newRoomForLogs = isPreArrival ? 'Pre-Arrival' : newRoomRaw;

        const btn = document.querySelector('#roomChangeModal button:last-child');
        const originalText = btn.textContent;
        btn.textContent = 'Saving...';
        btn.disabled = true;

        try {
            await ensureGuestActivity(); // eski isimle eşleşen log/rezervasyonları okumak için
            const rcNameLower = (rcGuestName || '').toLowerCase();

            // 1. Update Guest Directory
            const updates = {
                room: newRoomForDir,
                checkIn: checkInDate,
                checkOut: checkOutDate,
                lastUpdated: new Date().toISOString()
            };
            if (isPreArrival) updates.status = 'pre_arrival';
            if (nameChanged) updates.name = newName;

            // Aynı merge akışındaki gibi (bkz. yukarısı): tek batch 500 işlem
            // limitini aşabileceğinden ops toplanıp 450'lik parçalar halinde
            // commit edilir.
            const ops = [b => b.update(db.collection('guestDirectory').doc(rcGuestId), updates)];

            // 2. Update Guest Logs (Issues) — match by the OLD name, then sync room/name
            const gLogsToUpdate = guestLogs.filter(l => (l.guestName || '').toLowerCase() === rcNameLower);
            gLogsToUpdate.forEach(log => {
                const logUpdate = {};
                if (log.room !== newRoomForLogs) logUpdate.room = newRoomForLogs;
                if (nameChanged) logUpdate.guestName = newName;
                if (Object.keys(logUpdate).length) {
                    ops.push(b => b.update(db.collection('guestLogs').doc(log.id), logUpdate));
                }
            });

            // 3. Update Reservations (Concierge) — match by the OLD name, then sync room/name
            const gResToUpdate = reservations.filter(r => (r.guestName || '').toLowerCase() === rcNameLower);
            gResToUpdate.forEach(res => {
                const resUpdate = {};
                if (res.room !== newRoomForLogs) resUpdate.room = newRoomForLogs;
                if (nameChanged) resUpdate.guestName = newName;
                if (Object.keys(resUpdate).length) {
                    ops.push(b => b.update(db.collection('reservations').doc(res.id), resUpdate));
                }
            });

            const CHUNK = 450;
            for (let i = 0; i < ops.length; i += CHUNK) {
                const b = db.batch();
                ops.slice(i, i + CHUNK).forEach(applyOp => applyOp(b));
                await b.commit();
            }

            showToast('Stay details updated successfully.');
            closeRoomChangeModal();
            activityLoaded = false; // isim/oda değişti → aktiviteyi ve rehberi tazele
            await loadDirectory();
        } catch (e) {
            console.error(e);
            showToast('Error updating stay details.', true);
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    };

});
