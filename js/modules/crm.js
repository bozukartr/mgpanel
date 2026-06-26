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
        if (d.enabled && ends && ends > new Date()) window.location.replace('maintenance.html');
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
        if (!user) { window.location.href = 'login.html'; return; }
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
            localStorage.removeItem('hotelUsername'); localStorage.removeItem('hotelTenantId');
            window.location.href = 'login.html';
        });
    });

    // ── DATA STATE ─────────────────────────────────────────────
    let guestDirectory = [];
    let guestLogs = [];
    let reservations = [];
    let currentGuestId = null;
    let filterStatus = 'arrival';
    let timelineFilter = 'all';
    let rooms = [];
    let roomFilter = 'all';
    let currentView = 'guests';

    // Kayıtları (log/rezervasyon) misafire bağla: önce kalıcı guestId, yoksa isim.
    const guestMatch = (rec, guest) => {
        if (!rec || !guest) return false;
        if (rec.guestId && guest.id) return rec.guestId === guest.id;
        return (rec.guestName || '').toLowerCase() === (guest.name || '').toLowerCase();
    };

    // ── CORE FUNCTIONS ─────────────────────────────────────────
    const loadAllData = async () => {
        try {
            const dirSnap = await db.collection('guestDirectory').where('tenantId', '==', TENANT_ID).get();
            guestDirectory = dirSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            // Auto Check-Out past guests
            const today = new Date().toISOString().split('T')[0];
            const batch = db.batch();
            let needsCommit = false;

            guestDirectory.forEach(g => {
                if (g.status === 'in_house' && g.checkOut && g.checkOut < today) {
                    batch.update(db.collection('guestDirectory').doc(g.id), { status: 'checked_out' });
                    g.status = 'checked_out'; // Update local state immediately
                    needsCommit = true;
                }
            });

            if (needsCommit) {
                await batch.commit();
                console.log("Auto-checkout executed for past guests.");
            }

            const logsSnap = await db.collection('guestLogs').where('tenantId', '==', TENANT_ID).get();
            guestLogs = logsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            const resSnap = await db.collection('reservations').where('tenantId', '==', TENANT_ID).get();
            reservations = resSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            renderGuestList();
            if (currentGuestId) viewGuestDetail(currentGuestId);
            if (currentView === 'rooms' && typeof renderRooms === 'function') renderRooms();
        } catch (e) {
            console.error("Data load failed", e);
            showToast("Failed to sync data", true);
        }
    };


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

    window.viewGuestDetail = (guestId) => {
        currentGuestId = guestId;
        const guest = guestDirectory.find(g => g.id === guestId);
        if (!guest) return;

        // Render Active Card
        const cards = document.querySelectorAll('.guest-card');
        cards.forEach(c => c.classList.remove('active'));
        const activeCard = Array.from(cards).find(c => c.querySelector('.guest-card-name')?.textContent === guest.name);
        if (activeCard) activeCard.classList.add('active');

        const detailEl = document.getElementById('guestDetail');
        
        const gLogs = guestLogs.filter(l => guestMatch(l, guest));
        const gRes = reservations.filter(r => guestMatch(r, guest));

        const tags = generateTags(gLogs, gRes);
        if (guest.vip && !tags.includes('VIP')) tags.unshift('VIP');

        const contactBits = [
            guest.phone ? `<a class="cstat" href="tel:${esc(guest.phone)}">📞 ${esc(guest.phone)}</a>` : '',
            guest.email ? `<a class="cstat" href="mailto:${esc(guest.email)}">✉ ${esc(guest.email)}</a>` : '',
            guest.nationality ? `<span class="cstat">🌐 ${esc(guest.nationality)}</span>` : '',
            guest.language ? `<span class="cstat">🗣 ${esc(guest.language)}</span>` : '',
            guest.birthday ? `<span class="cstat">🎂 ${esc(guest.birthday)}</span>` : ''
        ].filter(Boolean).join('');

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
                        ${tags.map(t => `<span class="tag ${t === 'VIP' ? 'tag-vip' : ''}">${esc(t)}</span>`).join('')}
                    </div>
                    <div class="profile-room-badge">
                        Oda ${esc(guest.room || '—')} • Güncellendi ${new Date(guest.lastUpdated).toLocaleDateString('tr-TR')}
                        ${guest.checkIn ? `<br><span style="color:#2563eb; font-weight:600;">Giriş: ${esc(guest.checkIn)}</span>` : ''}
                        ${guest.checkOut ? ` <span style="color:#e11d48; font-weight:600; margin-left:10px;">Çıkış: ${esc(guest.checkOut)}</span>` : ''}
                    </div>
                </div>
                <div class="profile-actions" style="display: flex; gap: 8px;">
                    <button class="btn-status-toggle" style="background-color: #f59e0b; color: white;" 
                            onclick="openRoomChangeModal('${guest.id}', '${guest.name}', '${guest.room === 'Pre-Arrival' ? '' : (guest.room || '')}', '${guest.checkIn || ''}', '${guest.checkOut || ''}', '${guest.status}')">
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
                            onclick="deleteGuest('${guest.id}', '${guest.name.replace(/'/g, "\\'")}')">
                        Sil
                    </button>
                    ` : ''}
                </div>
            </div>

            ${contactBits ? `<div class="contact-strip">${contactBits}</div>` : ''}

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
            showToast(`Guest status updated: ${newStatus.replace('_',' ')}`);
            loadAllData();
        } catch (e) { showToast('Update failed', true); }
    };

    window.deleteGuest = async (guestId, guestName) => {
        if (!isAdminUser) {
            return showToast('Only Admin can delete guests!', true);
        }
        
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
            const batch = db.batch();
            const secName = secondary.name.toLowerCase();

            // Reassign the duplicate's reservations to the primary name
            reservations
                .filter(r => r.guestName && r.guestName.toLowerCase() === secName)
                .forEach(r => batch.update(db.collection('reservations').doc(r.id), { guestName: primary.name, guestId: primary.id }));

            // Reassign the duplicate's logs to the primary name
            guestLogs
                .filter(l => l.guestName && l.guestName.toLowerCase() === secName)
                .forEach(l => batch.update(db.collection('guestLogs').doc(l.id), { guestName: primary.name, guestId: primary.id }));

            // Merge notes
            const primaryNotes = (primary.notes || '').trim();
            const secondaryNotes = (secondary.notes || '').trim();
            let mergedNotes = primaryNotes;
            if (secondaryNotes && !primaryNotes.includes(secondaryNotes)) {
                mergedNotes = primaryNotes
                    ? `${primaryNotes}\n\n[Merged from ${secondary.name}]\n${secondaryNotes}`
                    : secondaryNotes;
            }

            batch.update(db.collection('guestDirectory').doc(primary.id), {
                notes: mergedNotes,
                lastUpdated: new Date().toISOString()
            });

            // Remove the duplicate profile
            batch.delete(db.collection('guestDirectory').doc(secondary.id));

            await batch.commit();

            showToast(`Merged "${secondary.name}" into "${primary.name}".`);
            closeMergeModal();
            currentGuestId = primary.id;
            await loadAllData();
            viewGuestDetail(primary.id);
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
        ['agName', 'agRoom', 'agCheckIn', 'agCheckOut', 'agPhone', 'agEmail', 'agNationality', 'agLanguage', 'agBirthday'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        const agVipEl = document.getElementById('agVip'); if (agVipEl) agVipEl.checked = false;
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
            await db.collection('guestDirectory').add({
                name: name,
                room: status === 'pre_arrival' ? (room || '') : room,
                status: status,
                checkIn: checkIn || '',
                checkOut: checkOut || '',
                phone: document.getElementById('agPhone').value.trim(),
                email: document.getElementById('agEmail').value.trim(),
                nationality: document.getElementById('agNationality').value.trim(),
                language: document.getElementById('agLanguage').value.trim(),
                birthday: document.getElementById('agBirthday').value.trim(),
                vip: !!document.getElementById('agVip').checked,
                tenantId: TENANT_ID,
                lastUpdated: new Date().toISOString()
            });
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

    window.openRoomChangeModal = (id, name, currentRoom, checkIn, checkOut, status) => {
        rcGuestId = id;
        rcGuestName = name;
        document.getElementById('rcGuestName').textContent = name;
        document.getElementById('rcGuestNameInput').value = name;
        document.getElementById('rcNewRoom').value = currentRoom;
        document.getElementById('rcCheckIn').value = toDisplayDate(checkIn) || '';
        document.getElementById('rcCheckOut').value = toDisplayDate(checkOut) || '';

        const g = guestDirectory.find(x => x.id === id) || {};
        const setVal = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v || ''; };
        setVal('rcPhone', g.phone); setVal('rcEmail', g.email); setVal('rcNationality', g.nationality);
        setVal('rcLanguage', g.language); setVal('rcBirthday', g.birthday);
        const vipBox = document.getElementById('rcVip'); if (vipBox) vipBox.checked = !!g.vip;

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
            const batch = db.batch();
            
            // 1. Update Guest Directory
            const updates = {
                room: newRoomForDir,
                checkIn: checkInDate,
                checkOut: checkOutDate,
                phone: (document.getElementById('rcPhone')?.value || '').trim(),
                email: (document.getElementById('rcEmail')?.value || '').trim(),
                nationality: (document.getElementById('rcNationality')?.value || '').trim(),
                language: (document.getElementById('rcLanguage')?.value || '').trim(),
                birthday: (document.getElementById('rcBirthday')?.value || '').trim(),
                vip: !!document.getElementById('rcVip')?.checked,
                lastUpdated: new Date().toISOString()
            };
            if (isPreArrival) updates.status = 'pre_arrival';
            if (nameChanged) updates.name = newName;

            batch.update(db.collection('guestDirectory').doc(rcGuestId), updates);

            // 2. Update Guest Logs (Issues) — match by the OLD name, then sync room/name
            const gLogsToUpdate = guestLogs.filter(l => l.guestName.toLowerCase() === rcGuestName.toLowerCase());
            gLogsToUpdate.forEach(log => {
                const logUpdate = {};
                if (log.room !== newRoomForLogs) logUpdate.room = newRoomForLogs;
                if (nameChanged) logUpdate.guestName = newName;
                if (!log.guestId && rcGuestId) logUpdate.guestId = rcGuestId;
                if (Object.keys(logUpdate).length) {
                    batch.update(db.collection('guestLogs').doc(log.id), logUpdate);
                }
            });

            // 3. Update Reservations (Concierge) — match by the OLD name, then sync room/name
            const gResToUpdate = reservations.filter(r => r.guestName.toLowerCase() === rcGuestName.toLowerCase());
            gResToUpdate.forEach(res => {
                const resUpdate = {};
                if (res.room !== newRoomForLogs) resUpdate.room = newRoomForLogs;
                if (nameChanged) resUpdate.guestName = newName;
                if (!res.guestId && rcGuestId) resUpdate.guestId = rcGuestId;
                if (Object.keys(resUpdate).length) {
                    batch.update(db.collection('reservations').doc(res.id), resUpdate);
                }
            });

            await batch.commit();

            showToast('Stay details updated successfully.');
            closeRoomChangeModal();
        } catch (e) {
            console.error(e);
            showToast('Error updating stay details.', true);
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    };

    // ── PMS: Odalar & Housekeeping ─────────────────────────────
    const ROOM_STATUS = {
        clean: { label: 'Temiz', cls: 'clean' },
        dirty: { label: 'Kirli', cls: 'dirty' },
        occupied: { label: 'Dolu', cls: 'occupied' },
        ooo: { label: 'Arıza', cls: 'ooo' }
    };
    function listenRooms() {
        db.collection('rooms').where('tenantId', '==', TENANT_ID).onSnapshot(snap => {
            rooms = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            if (currentView === 'rooms') renderRooms();
            if (currentView === 'bookings' && typeof renderTape === 'function') renderTape();
        }, e => console.error('rooms listen', e));
    }
    const roomNoSort = (a, b) => String(a.no).localeCompare(String(b.no), 'tr', { numeric: true });
    function occupantOf(room) {
        const g = guestDirectory.find(x => x.status === 'in_house' && String(x.room || '').trim() === String(room.no || '').trim());
        return g ? g.name : '';
    }
    function renderRooms() {
        const board = document.getElementById('roomsBoard');
        if (!board) return;
        const counts = { all: rooms.length, clean: 0, dirty: 0, occupied: 0, ooo: 0 };
        rooms.forEach(r => { if (counts[r.status] != null) counts[r.status]++; });
        const kpiEl = document.getElementById('roomsKpis');
        if (kpiEl) {
            const cards = [['Toplam', counts.all, 'all'], ['Temiz', counts.clean, 'clean'], ['Kirli', counts.dirty, 'dirty'], ['Dolu', counts.occupied, 'occupied'], ['Arıza', counts.ooo, 'ooo']];
            kpiEl.innerHTML = cards.map(([l, v, st]) => `<div class="room-kpi st-${st}"><span class="v">${v}</span><span class="l">${esc(l)}</span></div>`).join('');
        }
        const dl = document.getElementById('rmTypeList');
        if (dl) { const types = [...new Set(rooms.map(r => r.type).filter(Boolean))]; dl.innerHTML = types.map(t => `<option value="${esc(t)}">`).join(''); }
        if (!rooms.length) { board.innerHTML = `<div class="rooms-empty">Henüz oda yok.<br>“Varsayılan Oluştur” ile başlayın veya “+ Oda Ekle” deyin.</div>`; return; }
        const list = rooms.filter(r => roomFilter === 'all' || r.status === roomFilter);
        if (!list.length) { board.innerHTML = `<div class="rooms-empty">Bu filtrede oda yok.</div>`; return; }
        const floors = [...new Set(list.map(r => r.floor || '—'))].sort((a, b) => {
            const x = parseInt(a, 10), y = parseInt(b, 10);
            if (isNaN(x) && isNaN(y)) return String(a).localeCompare(String(b));
            if (isNaN(x)) return 1; if (isNaN(y)) return -1; return x - y;
        });
        board.innerHTML = floors.map(fl => {
            const rs = list.filter(r => (r.floor || '—') === fl).sort(roomNoSort);
            return `<div class="rooms-floor"><div class="rooms-floor-h">Kat ${esc(fl)}</div><div class="rooms-grid">${rs.map(roomCardHtml).join('')}</div></div>`;
        }).join('');
    }
    function roomCardHtml(r) {
        const occ = occupantOf(r);
        const st = ROOM_STATUS[r.status] || ROOM_STATUS.clean;
        return `<div class="room-card st-${st.cls}">
            <div class="room-top"><span class="room-no">${esc(r.no)}</span><button class="room-edit" onclick="editRoom('${r.id}')" title="Düzenle">⋯</button></div>
            <div class="room-meta">${esc(r.type || 'Standart')}</div>
            <div class="room-occ">${occ ? '👤 ' + esc(occ) : '<span class="muted">Boş</span>'}</div>
            <div class="room-status-row">
                ${Object.keys(ROOM_STATUS).map(k => `<button class="rs-dot ${k} ${r.status === k ? 'on' : ''}" title="${esc(ROOM_STATUS[k].label)}" onclick="setRoomStatus('${r.id}','${k}')"></button>`).join('')}
            </div>
        </div>`;
    }
    window.setRoomStatus = (id, st) => {
        db.collection('rooms').doc(id).update({ status: st, updatedAt: new Date().toISOString() })
            .then(() => showToast('Oda durumu: ' + (ROOM_STATUS[st] ? ROOM_STATUS[st].label : st)))
            .catch(e => { console.error(e); showToast('Güncellenemedi', true); });
    };

    let editingRoomId = null;
    function openRoomModal(room) {
        editingRoomId = room ? room.id : null;
        document.getElementById('roomModalTitle').textContent = room ? 'Oda Düzenle' : 'Oda Ekle';
        document.getElementById('rmNo').value = room ? (room.no || '') : '';
        document.getElementById('rmFloor').value = room ? (room.floor || '') : '';
        document.getElementById('rmType').value = room ? (room.type || '') : '';
        document.getElementById('rmStatus').value = room ? (room.status || 'clean') : 'clean';
        document.getElementById('rmNotes').value = room ? (room.notes || '') : '';
        document.getElementById('rmDelete').style.display = room ? 'inline-block' : 'none';
        const m = document.getElementById('roomModal');
        m.style.display = 'flex'; m.style.alignItems = 'center'; m.style.justifyContent = 'center';
        setTimeout(() => document.getElementById('rmNo')?.focus(), 60);
    }
    window.editRoom = (id) => { const r = rooms.find(x => x.id === id); if (r) openRoomModal(r); };
    function closeRoomModal() { document.getElementById('roomModal').style.display = 'none'; editingRoomId = null; }
    async function saveRoom() {
        const no = document.getElementById('rmNo').value.trim();
        if (!no) return showToast('Oda no zorunlu.', true);
        const data = {
            no: no, floor: document.getElementById('rmFloor').value.trim(),
            type: document.getElementById('rmType').value.trim() || 'Standart',
            status: document.getElementById('rmStatus').value,
            notes: document.getElementById('rmNotes').value.trim(),
            tenantId: TENANT_ID, updatedAt: new Date().toISOString()
        };
        try {
            if (editingRoomId) await db.collection('rooms').doc(editingRoomId).update(data);
            else {
                if (rooms.some(r => String(r.no).trim() === no) && !confirm('Bu oda no zaten var. Yine de eklensin mi?')) return;
                await db.collection('rooms').add(data);
            }
            closeRoomModal(); showToast('Oda kaydedildi.');
        } catch (e) { console.error(e); showToast('Kaydedilemedi.', true); }
    }
    async function deleteRoom() {
        if (!editingRoomId) return;
        if (!confirm('Bu oda silinsin mi?')) return;
        try { await db.collection('rooms').doc(editingRoomId).delete(); closeRoomModal(); showToast('Oda silindi.'); }
        catch (e) { console.error(e); showToast('Silinemedi.', true); }
    }
    async function seedRooms() {
        const msg = rooms.length ? 'Mevcut odalara ek olarak eksik 101–110 ve 201–210 odaları eklensin mi?' : '1. ve 2. kat için 101–110 ve 201–210 odaları oluşturulsun mu?';
        if (!confirm(msg)) return;
        const batch = db.batch(); let added = 0;
        [1, 2].forEach(fl => {
            for (let i = 1; i <= 10; i++) {
                const no = String(fl * 100 + i);
                if (rooms.some(r => String(r.no).trim() === no)) continue;
                const ref = db.collection('rooms').doc();
                batch.set(ref, { no: no, floor: String(fl), type: 'Standart', status: 'clean', notes: '', tenantId: TENANT_ID, updatedAt: new Date().toISOString() });
                added++;
            }
        });
        if (!added) { showToast('Eklenecek yeni oda yok.'); return; }
        try { await batch.commit(); showToast(added + ' oda oluşturuldu.'); } catch (e) { console.error(e); showToast('Oluşturulamadı.', true); }
    }

    function setView(v) {
        currentView = v;
        document.querySelectorAll('.crm-subtab').forEach(b => b.classList.toggle('active', b.dataset.view === v));
        const map = { guests: 'guestsView', rooms: 'roomsView', bookings: 'bookingsView' };
        Object.keys(map).forEach(k => { const el = document.getElementById(map[k]); if (el) el.style.display = (k === v) ? '' : 'none'; });
        if (v === 'rooms') renderRooms();
        if (v === 'bookings') { renderBkKpis(); renderTape(); renderBookingList(); }
    }
    document.querySelectorAll('.crm-subtab').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
    document.getElementById('roomsFilter')?.addEventListener('click', (e) => {
        const b = e.target.closest('.rf-btn'); if (!b) return;
        roomFilter = b.dataset.st;
        document.querySelectorAll('#roomsFilter .rf-btn').forEach(x => x.classList.toggle('active', x === b));
        renderRooms();
    });
    document.getElementById('addRoomBtn')?.addEventListener('click', () => openRoomModal(null));
    document.getElementById('seedRoomsBtn')?.addEventListener('click', seedRooms);
    document.getElementById('rmSave')?.addEventListener('click', saveRoom);
    document.getElementById('rmCancel')?.addEventListener('click', closeRoomModal);
    document.getElementById('rmDelete')?.addEventListener('click', deleteRoom);
    document.getElementById('roomModal')?.addEventListener('click', (e) => { if (e.target.id === 'roomModal') closeRoomModal(); });
    listenRooms();

    // ════════════════════════════════════════════════════════════
    //  PMS: Oda Tipleri & Fiyat · Rezervasyonlar (tape-chart)
    // ════════════════════════════════════════════════════════════
    let roomTypes = [];
    let bookings = [];
    const TAPE_DAYS = 14;
    let tapeStart = new Date().toISOString().split('T')[0];
    let editingBookingId = null;

    const BK_STATUS = {
        confirmed: { label: 'Onaylı', cls: 'confirmed' },
        in_house: { label: 'Konaklıyor', cls: 'inhouse' },
        checked_out: { label: 'Çıkış yaptı', cls: 'out' },
        cancelled: { label: 'İptal', cls: 'cancelled' }
    };
    const bookingActive = (b) => b.status === 'confirmed' || b.status === 'in_house';
    const addDaysIso = (iso, d) => { const dt = new Date(iso + 'T00:00:00'); dt.setDate(dt.getDate() + d); return dt.toISOString().split('T')[0]; };
    const diffDays = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
    const todayIso = () => new Date().toISOString().split('T')[0];
    const fmtDayShort = (iso) => { const dt = new Date(iso + 'T00:00:00'); const wd = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'][dt.getDay()]; const p = n => n < 10 ? '0' + n : '' + n; return wd + ' ' + p(dt.getDate()) + '/' + p(dt.getMonth() + 1); };
    const money = (v) => '₺' + (Number(v) || 0).toLocaleString('tr-TR');
    const overlaps = (ci1, co1, ci2, co2) => ci1 < co2 && ci2 < co1;

    function listenRoomTypes() {
        db.collection('roomTypes').where('tenantId', '==', TENANT_ID).onSnapshot(s => {
            roomTypes = s.docs.map(d => ({ id: d.id, ...d.data() }));
            if (document.getElementById('roomTypesModal').style.display !== 'none') renderRoomTypes();
        }, e => console.error('roomTypes', e));
    }
    function listenBookings() {
        db.collection('bookings').where('tenantId', '==', TENANT_ID).onSnapshot(s => {
            bookings = s.docs.map(d => ({ id: d.id, ...d.data() }));
            if (currentView === 'bookings') { renderBkKpis(); renderTape(); renderBookingList(); }
        }, e => console.error('bookings', e));
    }
    // Tip adlarını odalardan + roomTypes'tan birleştir.
    function typeNames() {
        const set = new Set();
        roomTypes.forEach(t => t.name && set.add(t.name));
        rooms.forEach(r => r.type && set.add(r.type));
        return [...set];
    }
    function rateOfType(name) { const t = roomTypes.find(x => x.name === name); return t ? (Number(t.baseRate) || 0) : 0; }
    function availableRooms(typeName, ci, co, excludeId) {
        return rooms.filter(r => (r.type || '') === typeName)
            .filter(r => !bookings.some(b => b.id !== excludeId && bookingActive(b) && b.roomNo === r.no && overlaps(ci, co, b.checkIn, b.checkOut)));
    }

    // ── Tape-chart ─────────────────────────────────────────────
    function renderBkKpis() {
        const el = document.getElementById('bkKpis'); if (!el) return;
        const t = todayIso();
        const arr = bookings.filter(b => b.status === 'confirmed' && b.checkIn === t).length;
        const dep = bookings.filter(b => b.status === 'in_house' && b.checkOut === t).length;
        const inh = bookings.filter(b => b.status === 'in_house').length;
        const up = bookings.filter(b => b.status === 'confirmed' && b.checkIn > t).length;
        const cards = [['Bugün Giriş', arr, 'arr'], ['Bugün Çıkış', dep, 'dep'], ['Konaklayan', inh, 'inh'], ['Yaklaşan', up, 'up']];
        el.innerHTML = cards.map(([l, v, k]) => `<div class="room-kpi bk-${k}"><span class="v">${v}</span><span class="l">${esc(l)}</span></div>`).join('');
    }
    function renderTape() {
        const tape = document.getElementById('tape'); if (!tape) return;
        const rangeEl = document.getElementById('tapeRange');
        if (rangeEl) rangeEl.textContent = fmtDayShort(tapeStart) + ' — ' + fmtDayShort(addDaysIso(tapeStart, TAPE_DAYS - 1));
        const cw = 48;
        const days = []; for (let i = 0; i < TAPE_DAYS; i++) days.push(addDaysIso(tapeStart, i));
        const tIso = todayIso();
        let html = `<div class="tape-row tape-head"><div class="tape-room-col">Oda</div><div class="tape-cells" style="width:${TAPE_DAYS * cw}px">`
            + days.map(d => `<div class="tape-dayh${d === tIso ? ' today' : ''}" style="width:${cw}px">${fmtDayShort(d)}</div>`).join('') + `</div></div>`;
        const sorted = rooms.slice().sort((a, b) => { const fa = parseInt(a.floor, 10) || 0, fb = parseInt(b.floor, 10) || 0; if (fa !== fb) return fa - fb; return roomNoSort(a, b); });
        if (!sorted.length) { tape.innerHTML = html + `<div class="rooms-empty">Önce “Odalar” sekmesinden oda ekleyin (tape-chart odalardan oluşur).</div>`; return; }
        html += sorted.map(r => {
            const bars = bookings.filter(b => b.roomNo === r.no && bookingActive(b)).map(b => {
                const s = Math.max(0, diffDays(tapeStart, b.checkIn));
                const e = Math.min(TAPE_DAYS, diffDays(tapeStart, b.checkOut));
                if (e <= 0 || s >= TAPE_DAYS || e <= s) return '';
                return `<div class="tape-bar st-${(BK_STATUS[b.status] || {}).cls || 'confirmed'}" style="left:${s * cw + 2}px;width:${(e - s) * cw - 4}px" onclick="openBooking('${b.id}')" title="${esc(b.guestName)} · ${esc(b.checkIn)}→${esc(b.checkOut)}">${esc(b.guestName)}</div>`;
            }).join('');
            const cells = days.map(d => `<div class="daycell${d === tIso ? ' today' : ''}" style="width:${cw}px"></div>`).join('');
            return `<div class="tape-row"><div class="tape-room-col">${esc(r.no)}<small>${esc(r.type || '')}</small></div><div class="tape-cells" style="width:${TAPE_DAYS * cw}px">${cells}${bars}</div></div>`;
        }).join('');
        tape.innerHTML = html;
    }
    function renderBookingList() {
        const el = document.getElementById('bkList'); if (!el) return;
        if (!bookings.length) { el.innerHTML = `<div class="rooms-empty">Henüz rezervasyon yok. “+ Yeni Rezervasyon” ile ekleyin.</div>`; return; }
        const order = { confirmed: 0, in_house: 1, checked_out: 2, cancelled: 3 };
        const sorted = bookings.slice().sort((a, b) => (order[a.status] - order[b.status]) || (a.checkIn || '').localeCompare(b.checkIn || ''));
        el.innerHTML = sorted.map(b => {
            const st = BK_STATUS[b.status] || BK_STATUS.confirmed;
            let actions = '';
            if (b.status === 'confirmed') actions += `<button class="bk-act in" onclick="checkInBooking('${b.id}')">Check-in</button>`;
            if (b.status === 'in_house') actions += `<button class="bk-act out" onclick="checkOutBooking('${b.id}')">Check-out</button>`;
            if (b.status === 'confirmed' || b.status === 'in_house') actions += `<button class="bk-act cancel" onclick="cancelBooking('${b.id}')">İptal</button>`;
            return `<div class="bk-row" onclick="openBooking('${b.id}')">
                <div class="bk-row-main"><b>${esc(b.guestName)}</b><span class="bk-badge ${st.cls}">${esc(st.label)}</span></div>
                <div class="bk-row-sub">Oda ${esc(b.roomNo || '—')} · ${esc(b.roomType || '')} · ${esc(b.checkIn)} → ${esc(b.checkOut)} · ${esc(b.nights || 0)} gece · ${esc(money(b.total))}</div>
                <div class="bk-row-actions" onclick="event.stopPropagation()">${actions}</div>
            </div>`;
        }).join('');
    }

    // ── Booking modal ──────────────────────────────────────────
    function fillTypeSelect() {
        const sel = document.getElementById('bkType'); if (!sel) return;
        const names = typeNames();
        sel.innerHTML = names.length ? names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') : '<option value="">— önce oda/tip ekleyin —</option>';
        const dl = document.getElementById('bkGuestList');
        if (dl) dl.innerHTML = guestDirectory.map(g => `<option value="${esc(g.name)}">`).join('');
    }
    function refreshRoomOptions() {
        const sel = document.getElementById('bkRoom'); if (!sel) return;
        const type = document.getElementById('bkType').value;
        const ci = toIsoDate(smartExpandDate(document.getElementById('bkCheckIn').value.trim()));
        const co = toIsoDate(smartExpandDate(document.getElementById('bkCheckOut').value.trim()));
        let avail = (ci && co && co > ci) ? availableRooms(type, ci, co, editingBookingId) : rooms.filter(r => (r.type || '') === type);
        // düzenlemede mevcut oda da seçilebilsin
        const cur = editingBookingId ? (bookings.find(b => b.id === editingBookingId) || {}).roomNo : null;
        if (cur && !avail.some(r => r.no === cur)) { const cr = rooms.find(r => r.no === cur); if (cr) avail = [cr, ...avail]; }
        sel.innerHTML = avail.length ? avail.sort(roomNoSort).map(r => `<option value="${esc(r.no)}">${esc(r.no)}</option>`).join('') : '<option value="">— uygun oda yok —</option>';
    }
    function refreshBkSummary() {
        const ci = toIsoDate(smartExpandDate(document.getElementById('bkCheckIn').value.trim()));
        const co = toIsoDate(smartExpandDate(document.getElementById('bkCheckOut').value.trim()));
        const sum = document.getElementById('bkSummary');
        const rate = Number(document.getElementById('bkRate').value) || 0;
        if (ci && co && co > ci) {
            const n = diffDays(ci, co);
            sum.innerHTML = `<span>${n} gece × ${money(rate)}</span><b>${money(n * rate)}</b>`;
            sum.classList.remove('warn');
        } else { sum.innerHTML = `<span class="muted">Geçerli giriş/çıkış tarihleri girin (çıkış > giriş).</span>`; sum.classList.add('warn'); }
    }
    function onTypeOrDateChange() {
        const type = document.getElementById('bkType').value;
        const rateInput = document.getElementById('bkRate');
        if (!rateInput.value || rateInput.dataset.auto === '1') { rateInput.value = rateOfType(type) || ''; rateInput.dataset.auto = '1'; }
        refreshRoomOptions(); refreshBkSummary();
    }
    window.openBooking = (id) => {
        const b = bookings.find(x => x.id === id); if (!b) return;
        openBookingModal(b);
    };
    function openBookingModal(b) {
        editingBookingId = b ? b.id : null;
        fillTypeSelect();
        document.getElementById('bookingModalTitle').textContent = b ? 'Rezervasyon' : 'Yeni Rezervasyon';
        document.getElementById('bkName').value = b ? (b.guestName || '') : '';
        document.getElementById('bkPhone').value = b ? (b.phone || '') : '';
        document.getElementById('bkEmail').value = b ? (b.email || '') : '';
        document.getElementById('bkType').value = b ? (b.roomType || '') : (typeNames()[0] || '');
        document.getElementById('bkPax').value = b ? (b.pax || 2) : 2;
        document.getElementById('bkCheckIn').value = b ? (toDisplayDate(b.checkIn) || '') : '';
        document.getElementById('bkCheckOut').value = b ? (toDisplayDate(b.checkOut) || '') : '';
        const rateEl = document.getElementById('bkRate');
        rateEl.value = b ? (b.rate || '') : (rateOfType(document.getElementById('bkType').value) || '');
        rateEl.dataset.auto = b ? '0' : '1';
        document.getElementById('bkNotes').value = b ? (b.notes || '') : '';
        document.getElementById('bkDelete').style.display = b ? 'inline-block' : 'none';
        refreshRoomOptions();
        if (b && b.roomNo) document.getElementById('bkRoom').value = b.roomNo;
        refreshBkSummary();
        // durum aksiyonları
        const sa = document.getElementById('bkStatusActions');
        if (b && (b.status === 'confirmed' || b.status === 'in_house')) {
            let h = '';
            if (b.status === 'confirmed') h += `<button class="crm-btn bk-st-in" onclick="checkInBooking('${b.id}')">Check-in yap</button>`;
            if (b.status === 'in_house') h += `<button class="crm-btn bk-st-out" onclick="checkOutBooking('${b.id}')">Check-out yap</button>`;
            h += `<button class="crm-btn crm-btn-ghost" onclick="cancelBooking('${b.id}')">Rezervasyonu iptal et</button>`;
            sa.innerHTML = h; sa.style.display = 'flex';
        } else { sa.innerHTML = ''; sa.style.display = 'none'; }
        const m = document.getElementById('bookingModal');
        m.style.display = 'flex'; m.style.alignItems = 'center'; m.style.justifyContent = 'center';
    }
    function closeBookingModal() { document.getElementById('bookingModal').style.display = 'none'; editingBookingId = null; }
    async function saveBooking() {
        const name = document.getElementById('bkName').value.trim();
        const type = document.getElementById('bkType').value;
        const ci = toIsoDate(smartExpandDate(document.getElementById('bkCheckIn').value.trim()));
        const co = toIsoDate(smartExpandDate(document.getElementById('bkCheckOut').value.trim()));
        const roomNo = document.getElementById('bkRoom').value;
        const rate = Number(document.getElementById('bkRate').value) || 0;
        if (!name) return showToast('Misafir adı zorunlu.', true);
        if (!type) return showToast('Oda tipi seçin.', true);
        if (!ci || !co || co <= ci) return showToast('Geçerli giriş/çıkış girin (çıkış > giriş).', true);
        if (!roomNo) return showToast('Uygun oda yok — tarih/tip değiştirin.', true);
        // çakışma kontrolü
        const clash = bookings.some(b => b.id !== editingBookingId && bookingActive(b) && b.roomNo === roomNo && overlaps(ci, co, b.checkIn, b.checkOut));
        if (clash) return showToast('Oda ' + roomNo + ' bu tarihlerde dolu.', true);
        const nights = diffDays(ci, co);
        const existing = editingBookingId ? bookings.find(b => b.id === editingBookingId) : null;
        const g = guestDirectory.find(x => (x.name || '').toLowerCase() === name.toLowerCase());
        const data = {
            tenantId: TENANT_ID, guestName: name, guestId: (existing && existing.guestId) || (g ? g.id : ''),
            phone: document.getElementById('bkPhone').value.trim(), email: document.getElementById('bkEmail').value.trim(),
            roomType: type, roomNo: roomNo, checkIn: ci, checkOut: co, nights: nights, pax: Math.max(1, parseInt(document.getElementById('bkPax').value, 10) || 1),
            rate: rate, total: nights * rate, notes: document.getElementById('bkNotes').value.trim(),
            status: existing ? existing.status : 'confirmed', updatedAt: new Date().toISOString()
        };
        try {
            if (editingBookingId) await db.collection('bookings').doc(editingBookingId).update(data);
            else { data.createdAt = new Date().toISOString(); await db.collection('bookings').add(data); }
            closeBookingModal(); showToast('Rezervasyon kaydedildi.');
        } catch (e) { console.error(e); showToast('Kaydedilemedi.', true); }
    }
    async function deleteBooking() {
        if (!editingBookingId) return;
        if (!confirm('Bu rezervasyon kalıcı olarak silinsin mi?')) return;
        try { await db.collection('bookings').doc(editingBookingId).delete(); closeBookingModal(); showToast('Rezervasyon silindi.'); }
        catch (e) { console.error(e); showToast('Silinemedi.', true); }
    }
    // ── Check-in / out / cancel (odalar + misafir kaydıyla entegre) ──
    async function upsertGuestForBooking(b, status) {
        let g = (b.guestId && guestDirectory.find(x => x.id === b.guestId))
            || guestDirectory.find(x => (x.name || '').toLowerCase() === (b.guestName || '').toLowerCase());
        const payload = {
            name: b.guestName, room: status === 'in_house' ? (b.roomNo || '') : (g ? g.room : ''),
            status: status, checkIn: b.checkIn, checkOut: b.checkOut,
            phone: b.phone || (g ? g.phone : '') || '', email: b.email || (g ? g.email : '') || '',
            tenantId: TENANT_ID, lastUpdated: new Date().toISOString()
        };
        if (g) { await db.collection('guestDirectory').doc(g.id).update(payload); return g.id; }
        const ref = await db.collection('guestDirectory').add(payload); return ref.id;
    }
    window.checkInBooking = async (id) => {
        const b = bookings.find(x => x.id === id); if (!b) return;
        if (!b.roomNo) return showToast('Önce oda atayın.', true);
        try {
            const gid = await upsertGuestForBooking(b, 'in_house');
            await db.collection('bookings').doc(id).update({ status: 'in_house', guestId: gid, updatedAt: new Date().toISOString() });
            const room = rooms.find(r => r.no === b.roomNo);
            if (room) await db.collection('rooms').doc(room.id).update({ status: 'occupied', updatedAt: new Date().toISOString() });
            closeBookingModal(); showToast(b.guestName + ' check-in yapıldı · Oda ' + b.roomNo);
            loadAllData();
        } catch (e) { console.error(e); showToast('Check-in başarısız.', true); }
    };
    window.checkOutBooking = async (id) => {
        const b = bookings.find(x => x.id === id); if (!b) return;
        if (!confirm(b.guestName + ' için check-out yapılsın mı?')) return;
        try {
            await db.collection('bookings').doc(id).update({ status: 'checked_out', updatedAt: new Date().toISOString() });
            const g = (b.guestId && guestDirectory.find(x => x.id === b.guestId)) || guestDirectory.find(x => (x.name || '').toLowerCase() === (b.guestName || '').toLowerCase());
            if (g) await db.collection('guestDirectory').doc(g.id).update({ status: 'checked_out', lastUpdated: new Date().toISOString() });
            const room = rooms.find(r => r.no === b.roomNo);
            if (room) await db.collection('rooms').doc(room.id).update({ status: 'dirty', updatedAt: new Date().toISOString() });
            closeBookingModal(); showToast(b.guestName + ' check-out yapıldı.');
            loadAllData();
        } catch (e) { console.error(e); showToast('Check-out başarısız.', true); }
    };
    window.cancelBooking = async (id) => {
        const b = bookings.find(x => x.id === id); if (!b) return;
        if (!confirm(b.guestName + ' rezervasyonu iptal edilsin mi?')) return;
        try { await db.collection('bookings').doc(id).update({ status: 'cancelled', updatedAt: new Date().toISOString() }); closeBookingModal(); showToast('Rezervasyon iptal edildi.'); }
        catch (e) { console.error(e); showToast('İptal edilemedi.', true); }
    };

    // ── Room types modal ───────────────────────────────────────
    function renderRoomTypes() {
        const el = document.getElementById('rtList'); if (!el) return;
        if (!roomTypes.length) { el.innerHTML = `<div class="rt-empty">Henüz tip yok. Aşağıdan ekleyin (örn. Standart · 2000 · 2).</div>`; return; }
        el.innerHTML = roomTypes.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(t => {
            const cnt = rooms.filter(r => (r.type || '') === t.name).length;
            return `<div class="rt-row">
                <div class="rt-name">${esc(t.name)}<small>${cnt} oda</small></div>
                <input class="rt-inp" type="number" value="${esc(t.baseRate || 0)}" onchange="updateRoomType('${t.id}','baseRate',this.value)" title="₺/gece">
                <input class="rt-inp sm" type="number" value="${esc(t.capacity || 2)}" onchange="updateRoomType('${t.id}','capacity',this.value)" title="Kişi">
                <button class="rt-del" onclick="deleteRoomType('${t.id}')" title="Sil">✕</button>
            </div>`;
        }).join('');
    }
    window.updateRoomType = (id, field, val) => {
        const v = field === 'name' ? val : (Number(val) || 0);
        db.collection('roomTypes').doc(id).update({ [field]: v, updatedAt: new Date().toISOString() }).catch(e => { console.error(e); showToast('Güncellenemedi', true); });
    };
    window.deleteRoomType = (id) => {
        if (!confirm('Bu oda tipi silinsin mi? (Odalar etkilenmez, sadece fiyat tanımı kalkar)')) return;
        db.collection('roomTypes').doc(id).delete().catch(e => { console.error(e); showToast('Silinemedi', true); });
    };
    async function addRoomType() {
        const name = document.getElementById('rtName').value.trim();
        if (!name) return showToast('Tip adı girin.', true);
        if (roomTypes.some(t => (t.name || '').toLowerCase() === name.toLowerCase())) return showToast('Bu tip zaten var.', true);
        try {
            await db.collection('roomTypes').add({ tenantId: TENANT_ID, name: name, baseRate: Number(document.getElementById('rtRate').value) || 0, capacity: Number(document.getElementById('rtCap').value) || 2, updatedAt: new Date().toISOString() });
            ['rtName', 'rtRate', 'rtCap'].forEach(i => document.getElementById(i).value = '');
            showToast('Tip eklendi.');
        } catch (e) { console.error(e); showToast('Eklenemedi.', true); }
    }
    function openRoomTypes() {
        // İlk açılışta odalardaki tipleri otomatik tohumla.
        if (!roomTypes.length) {
            const names = [...new Set(rooms.map(r => r.type).filter(Boolean))];
            if (names.length) {
                const batch = db.batch();
                names.forEach(n => batch.set(db.collection('roomTypes').doc(), { tenantId: TENANT_ID, name: n, baseRate: 0, capacity: 2, updatedAt: new Date().toISOString() }));
                batch.commit().catch(e => console.error(e));
            }
        }
        renderRoomTypes();
        const m = document.getElementById('roomTypesModal');
        m.style.display = 'flex'; m.style.alignItems = 'center'; m.style.justifyContent = 'center';
    }
    function closeRoomTypes() { document.getElementById('roomTypesModal').style.display = 'none'; }

    // ── Wiring ─────────────────────────────────────────────────
    document.getElementById('addBookingBtn')?.addEventListener('click', () => openBookingModal(null));
    document.getElementById('bkSave')?.addEventListener('click', saveBooking);
    document.getElementById('bkCancel')?.addEventListener('click', closeBookingModal);
    document.getElementById('bkDelete')?.addEventListener('click', deleteBooking);
    document.getElementById('bookingModal')?.addEventListener('click', (e) => { if (e.target.id === 'bookingModal') closeBookingModal(); });
    ['bkCheckIn', 'bkCheckOut'].forEach(id => document.getElementById(id)?.addEventListener('blur', (e) => { e.target.value = smartExpandDate(e.target.value.trim()); onTypeOrDateChange(); }));
    document.getElementById('bkType')?.addEventListener('change', onTypeOrDateChange);
    document.getElementById('bkRate')?.addEventListener('input', (e) => { e.target.dataset.auto = '0'; refreshBkSummary(); });
    document.getElementById('roomTypesBtn')?.addEventListener('click', openRoomTypes);
    document.getElementById('rtAddBtn')?.addEventListener('click', addRoomType);
    document.getElementById('rtClose')?.addEventListener('click', closeRoomTypes);
    document.getElementById('roomTypesModal')?.addEventListener('click', (e) => { if (e.target.id === 'roomTypesModal') closeRoomTypes(); });
    document.getElementById('tapePrev')?.addEventListener('click', () => { tapeStart = addDaysIso(tapeStart, -7); renderTape(); });
    document.getElementById('tapeNext')?.addEventListener('click', () => { tapeStart = addDaysIso(tapeStart, 7); renderTape(); });
    document.getElementById('tapeToday')?.addEventListener('click', () => { tapeStart = todayIso(); renderTape(); });
    listenRoomTypes();
    listenBookings();

});
