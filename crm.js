document.addEventListener('DOMContentLoaded', () => {
    // ── AUTH & INIT ───────────────────────────────────────────
    const userNameDisplay = document.getElementById('userNameDisplay');
    const loggedUsername = localStorage.getItem('hotelUsername') || 'Admin';
    if (userNameDisplay) userNameDisplay.textContent = loggedUsername;

    auth.onAuthStateChanged(user => {
        if (!user) window.location.href = 'index.html';
        if (loggedUsername.toLowerCase() === 'admin') {
            const adminLink = document.getElementById('adminLink');
            if (adminLink) adminLink.style.display = 'inline-block';
        }
    });

    document.getElementById('logoutBtn')?.addEventListener('click', () => {
        auth.signOut().then(() => {
            localStorage.removeItem('hotelUsername');
            window.location.href = 'index.html';
        });
    });

    // ── DATA STATE ─────────────────────────────────────────────
    let guestDirectory = [];
    let guestLogs = [];
    let reservations = [];
    let currentGuestId = null;
    let filterStatus = 'all';
    let timelineFilter = 'all';

    // ── CORE FUNCTIONS ─────────────────────────────────────────
    const loadAllData = async () => {
        try {
            const dirSnap = await db.collection('guestDirectory').get();
            guestDirectory = dirSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            const logsSnap = await db.collection('guestLogs').get();
            guestLogs = logsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            const resSnap = await db.collection('reservations').get();
            reservations = resSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            renderGuestList();
            if (currentGuestId) viewGuestDetail(currentGuestId);
        } catch (e) {
            console.error("Data load failed", e);
            showToast("Failed to sync data", true);
        }
    };


    const generateTags = (logs, res) => {
        const tags = [];
        if (res.length > 2) tags.push('Loyal Guest');
        if (logs.length > 3) tags.push('Frequent Issues');
        if (res.some(r => r.serviceType === 'VIP')) tags.push('VIP');
        if (logs.some(l => l.complaint?.toLowerCase().includes('birthday'))) tags.push('Special Occasion');
        return tags;
    };

    const renderGuestList = () => {
        const listEl = document.getElementById('guestList');
        const search = document.getElementById('guestSearch').value.toLowerCase();
        
        let filtered = guestDirectory.filter(g => {
            const matchesSearch = g.name.toLowerCase().includes(search) || (g.room && g.room.includes(search));
            const matchesStatus = filterStatus === 'all' || g.status === filterStatus;
            return matchesSearch && matchesStatus;
        });

        // Sort by lastUpdated or status
        filtered.sort((a,b) => (b.lastUpdated || '').localeCompare(a.lastUpdated || ''));

        listEl.innerHTML = filtered.map(g => `
            <div class="guest-card ${currentGuestId === g.id ? 'active' : ''}" onclick="viewGuestDetail('${g.id}')">
                <div class="guest-card-header">
                    <span class="guest-card-name">${g.name}</span>
                    <span class="guest-card-status ${g.status === 'in_house' ? 'status-in-house' : 'status-checked-out'}">
                        ${g.status === 'in_house' ? 'In House' : 'Checked Out'}
                    </span>
                </div>
                <div class="guest-card-room">Room: ${g.room || 'N/A'}</div>
            </div>
        `).join('');
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
        
        const gLogs = guestLogs.filter(l => l.guestName.toLowerCase() === guest.name.toLowerCase());
        const gRes = reservations.filter(r => r.guestName.toLowerCase() === guest.name.toLowerCase());
        
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
                    <h1>${guest.name}</h1>
                    <div class="guest-tags" style="margin: 8px 0;">
                        ${tags.map(t => `<span class="tag">${t}</span>`).join('')}
                    </div>
                    <div class="profile-room-badge">
                        Room ${guest.room || 'N/A'} • Registry updated ${new Date(guest.lastUpdated).toLocaleDateString()}
                    </div>
                </div>
                <div class="profile-actions">
                    <button class="btn-status-toggle ${guest.status === 'in_house' ? 'btn-checked-out' : 'btn-in-house'}" 
                            onclick="toggleStatus('${guest.id}', '${guest.status === 'in_house' ? 'checked_out' : 'in_house'}')">
                        ${guest.status === 'in_house' ? 'Check Out Now' : 'Check In (In House)'}
                    </button>
                </div>
            </div>

            <div class="guest-notes-area">
                <div class="notes-header">
                    <span>Internal Staff Notes & Preferences</span>
                    <span style="opacity:0.6; font-size:10px;">Autosaving...</span>
                </div>
                <div class="notes-content">
                    <textarea id="guestNotesInput" placeholder="Add preferences, allergies, or special requests..." 
                              oninput="updateGuestNotes('${guest.id}', this.value)">${guest.notes || ''}</textarea>
                </div>
            </div>

            <div class="profile-grid">
                <div class="info-card">
                    <label>Total Interactions</label>
                    <div class="val">${interactions.length}</div>
                </div>
                <div class="info-card">
                    <label>Issue Resolution</label>
                    <div class="val">${gLogs.length === 0 ? '100%' : Math.round((gLogs.filter(l => l.status === 'Solved').length / gLogs.length) * 100) + '%'}</div>
                </div>
                <div class="info-card">
                    <label>Active Status</label>
                    <div class="val" style="color:${guest.status === 'in_house' ? '#10b981' : '#64748b'}">${guest.status === 'in_house' ? 'IN HOUSE' : 'CHECKED OUT'}</div>
                </div>
            </div>

            <div class="interaction-history">
                <div class="detail-tabs">
                    <button class="tab-link ${timelineFilter === 'all' ? 'active' : ''}" onclick="setTimelineFilter('all')">All Interactions</button>
                    <button class="tab-link ${timelineFilter === 'issues' ? 'active' : ''}" onclick="setTimelineFilter('issues')">Guest Issues</button>
                    <button class="tab-link ${timelineFilter === 'concierge' ? 'active' : ''}" onclick="setTimelineFilter('concierge')">Concierge</button>
                </div>
                
                <div class="history-timeline">
                    ${filteredInteractions.length === 0 ? '<p style="color:#888; padding:20px;">No records found for this category.</p>' : filteredInteractions.map(i => {
                        const isIssue = i.interactionType === 'issue';
                        const title = isIssue ? i.complaint : `${i.type} Reservation ${i.resName || i.vehicle || i.vessel || ''}`;
                        const desc = isIssue ? (i.solution || '') : (i.notes || '');
                        
                        return `
                            <div class="timeline-item ${isIssue ? 'issue' : 'concierge'}">
                                <div class="item-header">
                                    <span class="item-type type-${isIssue ? 'issue' : 'concierge'}">${isIssue ? 'Issue Log' : 'Concierge'}</span>
                                    <span class="item-date">${new Date(i.sortDate).toLocaleDateString()}</span>
                                </div>
                                <div class="item-title">${title}</div>
                                <div class="item-desc">${desc}</div>
                                <div style="font-size:11px; color:#94a3b8; margin-top:8px;">
                                    ${isIssue ? `Dept: ${i.department} • Staff: ${i.staffInitial}` : `Time: ${i.time || '—'} • Status: ${i.status} • Staff: ${i.staffInitial}`}
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

    // ── EVENT LISTENERS ────────────────────────────────────────
    document.getElementById('guestSearch')?.addEventListener('input', renderGuestList);
    
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
});
