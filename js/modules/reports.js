/* StayOS — Raporlar (Misafir Kayıtları rapor merkezi).
 *
 * Standalone page (reports.html), app-shell içinde "Raporlar" sekmesi olarak
 * gömülü çalışır. guestLogs üzerinden çok boyutlu filtreleme + gruplama yapar;
 * Excel (profesyonel tablolu .xls) ve Yazdır çıktısı üretir.
 */
(function () {
    'use strict';
    if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') return;

    // ── Helpers ────────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const $ = id => document.getElementById(id);
    function toast(msg, isErr) {
        const t = $('toast'); if (!t) return;
        t.textContent = msg; t.className = 'rep-toast show' + (isErr ? ' err' : '');
        setTimeout(() => { t.className = 'rep-toast'; }, 2600);
    }
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function todayStr() { return ymd(new Date()); }
    function parseDateStr(s) {
        if (!s) return null;
        const p = String(s).split('-');
        if (p.length === 3) { const d = new Date(+p[0], +p[1] - 1, +p[2]); return isNaN(d) ? null : d; }
        const d = new Date(s); return isNaN(d) ? null : d;
    }
    function fmtDateTR(s) {
        const d = parseDateStr(s); if (!d) return s || '—';
        return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
    }
    function tsToDate(v) {
        if (!v) return null;
        if (v.toDate) { try { return v.toDate(); } catch (e) { return null; } }
        if (v instanceof Date) return v;
        if (typeof v === 'number') return new Date(v);
        if (v.seconds) return new Date(v.seconds * 1000);
        return null;
    }
    function fmtDuration(ms) {
        if (ms == null || isNaN(ms) || ms < 0) return '—';
        const m = Math.floor(ms / 60000);
        if (m < 60) return m + ' dk';
        const h = Math.floor(m / 60);
        if (h < 24) return h + ' sa ' + (m % 60) + ' dk';
        const d = Math.floor(h / 24);
        return d + ' g ' + (h % 24) + ' sa';
    }

    const STATUS_LABEL = { Following: 'Bekliyor', InProgress: 'İşlemde', Solved: 'Tamamlandı' };
    const statusLabel = s => STATUS_LABEL[s] || 'Bekliyor';
    const typeLabel = r => ((r.type || 'complaint') === 'request' ? 'Talep' : 'Şikayet');
    const OVERDUE_MIN = 15;
    function isOverdue(r) {
        if ((r.status || 'Following') === 'Solved') return false;
        const c = tsToDate(r.createdAt);
        if (!c) return false;
        return (Date.now() - c.getTime()) / 60000 > OVERDUE_MIN;
    }
    function durationOf(r) {
        const created = tsToDate(r.createdAt), done = tsToDate(r.completedAt);
        if ((r.status || '') === 'Solved' && created && done) return done - created;
        if (created) return Date.now() - created;
        return null;
    }

    // ── State ──────────────────────────────────────────────────
    let records = [];
    let ready = false;
    const F = {
        type: 'all',
        preset: 'all',
        from: '', to: '',
        depts: new Set(),
        topics: new Set(),
        statuses: new Set(),
        staff: '',
        room: '',
        guest: '',
        groupBy: 'none'
    };

    // Resolve the active date window from the preset (or custom inputs).
    function dateWindow() {
        const now = new Date();
        const t = todayStr();
        const startOfMonth = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
        switch (F.preset) {
            case 'today': return { from: t, to: t };
            case 'yesterday': { const y = new Date(now); y.setDate(now.getDate() - 1); return { from: ymd(y), to: ymd(y) }; }
            case '7': { const a = new Date(now); a.setDate(now.getDate() - 6); return { from: ymd(a), to: t }; }
            case '30': { const a = new Date(now); a.setDate(now.getDate() - 29); return { from: ymd(a), to: t }; }
            case 'thismonth': return { from: startOfMonth, to: t };
            case 'lastmonth': {
                const a = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                const b = new Date(now.getFullYear(), now.getMonth(), 0);
                return { from: ymd(a), to: ymd(b) };
            }
            case 'custom': return { from: F.from || '', to: F.to || '' };
            default: return { from: '', to: '' };
        }
    }
    function rangeLabel() {
        const w = dateWindow();
        if (F.preset === 'all') return 'Tüm Zamanlar';
        if (!w.from && !w.to) return 'Tüm Zamanlar';
        if (w.from === w.to) return fmtDateTR(w.from);
        return fmtDateTR(w.from) + ' – ' + fmtDateTR(w.to);
    }

    // ── Filtering ──────────────────────────────────────────────
    function filtered() {
        const w = dateWindow();
        const room = F.room.trim().toLowerCase();
        const guest = F.guest.trim().toLowerCase();
        return records.filter(r => {
            if (F.type !== 'all' && (r.type || 'complaint') !== F.type) return false;
            if (w.from && (r.date || '') < w.from) return false;
            if (w.to && (r.date || '') > w.to) return false;
            if (F.depts.size && !F.depts.has(r.department || '—')) return false;
            if (F.topics.size) {
                if ((r.type || 'complaint') !== 'complaint') return false;
                if (!F.topics.has(r.topic || 'Genel')) return false;
            }
            if (F.statuses.size) {
                const st = r.status || 'Following';
                let ok = F.statuses.has(st);
                if (!ok && F.statuses.has('Overdue') && isOverdue(r)) ok = true;
                if (!ok) return false;
            }
            if (F.staff && (r.staffInitial || '') !== F.staff) return false;
            if (room && !String(r.room || '').toLowerCase().includes(room)) return false;
            if (guest && !String(r.guestName || '').toLowerCase().includes(guest)) return false;
            return true;
        }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    }

    function summary(rows) {
        const s = { total: rows.length, complaint: 0, request: 0, following: 0, inprogress: 0, solved: 0, overdue: 0 };
        rows.forEach(r => {
            if ((r.type || 'complaint') === 'request') s.request++; else s.complaint++;
            const st = r.status || 'Following';
            if (st === 'Solved') s.solved++;
            else { if (st === 'InProgress') s.inprogress++; else s.following++; if (isOverdue(r)) s.overdue++; }
        });
        s.solveRate = s.total ? Math.round((s.solved / s.total) * 100) : 0;
        return s;
    }

    // ── Grouping ───────────────────────────────────────────────
    function groupKey(r) {
        switch (F.groupBy) {
            case 'department': return r.department || '—';
            case 'topic': return (r.type || 'complaint') === 'complaint' ? (r.topic || 'Genel') : '— (talep)';
            case 'status': return statusLabel(r.status || 'Following');
            case 'type': return typeLabel(r);
            case 'staff': return r.staffInitial || '—';
            case 'room': return r.room || '—';
            case 'guestName': return r.guestName || '—';
            case 'date': return r.date || '—';
            default: return '';
        }
    }
    function grouped(rows) {
        if (F.groupBy === 'none') return [{ key: '', rows: rows }];
        const map = new Map();
        rows.forEach(r => { const k = groupKey(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); });
        const arr = [...map.entries()].map(([key, rs]) => ({ key, rows: rs }));
        // Largest groups first; dates ascending by label for readability.
        if (F.groupBy === 'date') arr.sort((a, b) => String(b.key).localeCompare(String(a.key)));
        else arr.sort((a, b) => b.rows.length - a.rows.length || String(a.key).localeCompare(String(b.key), 'tr'));
        return arr;
    }

    // ── Columns / row values ───────────────────────────────────
    const COLS = ['Tarih', 'Oda', 'Misafir', 'Tür', 'Departman', 'Konu', 'Açıklama', 'Çözüm', 'Personel', 'Durum', 'Süre'];
    function rowValues(r) {
        const isReq = (r.type || 'complaint') === 'request';
        return [
            fmtDateTR(r.date),
            r.room || '—',
            r.guestName || '—',
            typeLabel(r),
            r.department || '—',
            isReq ? '—' : (r.topic || 'Genel'),
            r.complaint || '',
            isReq ? '' : (r.solution || ''),
            r.staffInitial || '—',
            statusLabel(r.status || 'Following') + (isOverdue(r) ? ' ⚠' : ''),
            fmtDuration(durationOf(r))
        ];
    }

    // ── Render preview ─────────────────────────────────────────
    function render() {
        const rows = filtered();
        const s = summary(rows);

        const groupName = $('repGroupBy').selectedOptions[0] ? $('repGroupBy').selectedOptions[0].textContent : '';
        $('repTitle').textContent = (F.type === 'request' ? 'Talepler' : F.type === 'complaint' ? 'Şikayetler' : 'Tüm Kayıtlar');
        $('repRangeLabel').textContent = rangeLabel() + (F.groupBy !== 'none' ? ' · ' + groupName : '');

        // Stat cards
        $('repStats').innerHTML = [
            ['Toplam', s.total, 'i'],
            ['Şikayet', s.complaint, 'c'],
            ['Talep', s.request, 'r'],
            ['Bekliyor', s.following, 'w'],
            ['İşlemde', s.inprogress, 'p'],
            ['Tamamlandı', s.solved, 's'],
            ['Geciken', s.overdue, 'o'],
            ['Çözüm Oranı', '%' + s.solveRate, 'k']
        ].map(([l, v, c]) => `<div class="rep-stat s-${c}"><span class="v">${esc(v)}</span><span class="l">${esc(l)}</span></div>`).join('');

        // Table (grouped or flat). Cap preview rows for performance.
        const groups = grouped(rows);
        const MAX = 400;
        let shown = 0, truncated = false;
        let html = '';
        if (!rows.length) {
            html = `<div class="rep-empty">Seçili filtrelerle kayıt bulunamadı.</div>`;
        } else {
            html = `<table class="rep-table"><thead><tr>${COLS.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>`;
            for (const g of groups) {
                if (g.key !== '') {
                    html += `<tr class="rep-grp"><td colspan="${COLS.length}">${esc(g.key)} <span>${g.rows.length} kayıt</span></td></tr>`;
                }
                for (const r of g.rows) {
                    if (shown >= MAX) { truncated = true; break; }
                    const vals = rowValues(r);
                    const od = isOverdue(r);
                    html += `<tr${od ? ' class="rep-od"' : ''}>` + vals.map((v, i) =>
                        `<td class="${i === 6 || i === 7 ? 'rep-wrap' : ''}">${esc(v)}</td>`).join('') + `</tr>`;
                    shown++;
                }
                if (truncated) break;
            }
            html += `</tbody></table>`;
            if (truncated) html += `<div class="rep-more">Önizlemede ilk ${MAX} kayıt gösteriliyor · Excel/Yazdır tüm ${rows.length} kaydı içerir.</div>`;
        }
        $('repTableScroll').innerHTML = html;
    }

    // ── Filter description (for exports) ───────────────────────
    function filterDesc() {
        const parts = [];
        parts.push('Tür: ' + (F.type === 'request' ? 'Talep' : F.type === 'complaint' ? 'Şikayet' : 'Tümü'));
        parts.push('Tarih: ' + rangeLabel());
        if (F.depts.size) parts.push('Departman: ' + [...F.depts].join(', '));
        if (F.topics.size) parts.push('Konu: ' + [...F.topics].join(', '));
        if (F.statuses.size) parts.push('Durum: ' + [...F.statuses].map(x => x === 'Overdue' ? 'Geciken' : statusLabel(x)).join(', '));
        if (F.staff) parts.push('Personel: ' + F.staff);
        if (F.room) parts.push('Oda: ' + F.room);
        if (F.guest) parts.push('Misafir: ' + F.guest);
        const gName = $('repGroupBy').selectedOptions[0] ? $('repGroupBy').selectedOptions[0].textContent : '';
        if (F.groupBy !== 'none') parts.push('Gruplama: ' + gName);
        return parts;
    }

    // ── Excel export (HTML→.xls, profesyonel tablolu) ──────────
    function exportExcel() {
        const rows = filtered();
        if (!rows.length) { toast('Bu rapor için veri yok.', true); return; }
        const s = summary(rows);
        const groups = grouped(rows);
        const title = $('repTitle').textContent;

        const sumRows = [
            ['Toplam Kayıt', s.total], ['Şikayet', s.complaint], ['Talep', s.request],
            ['Bekliyor', s.following], ['İşlemde', s.inprogress], ['Tamamlandı', s.solved],
            ['Geciken', s.overdue], ['Çözüm Oranı', '%' + s.solveRate]
        ];

        const colW = [70, 50, 150, 60, 110, 110, 280, 280, 70, 90, 80];
        const headTr = '<tr>' + COLS.map((c, i) => `<th style="width:${colW[i]}px">${esc(c)}</th>`).join('') + '</tr>';

        let body = '';
        for (const g of groups) {
            if (g.key !== '') {
                body += `<tr><td class="grp" colspan="${COLS.length}">${esc(g.key)}  (${g.rows.length} kayıt)</td></tr>`;
            }
            for (const r of g.rows) {
                const vals = rowValues(r);
                body += '<tr>' + vals.map((v, i) => `<td class="${i === 6 || i === 7 ? 'wide' : (i === 0 || i === 1 || i === 9 || i === 10 ? 'c' : '')}">${esc(v)}</td>`).join('') + '</tr>';
            }
            if (F.groupBy !== 'none' && g.key !== '') {
                body += `<tr><td class="sub" colspan="${COLS.length}">Ara toplam: ${g.rows.length}</td></tr>`;
            }
        }

        const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Rapor</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
  table{border-collapse:collapse;font-family:'Segoe UI',Arial,sans-serif;font-size:10pt;margin-bottom:14px}
  td,th{border:0.5pt solid #c9ced6;padding:6px 8px;vertical-align:middle;mso-data-placement:same-cell}
  th{background:#111827;color:#fff;font-weight:bold;text-align:center}
  .c{text-align:center}
  .wide{width:280px;white-space:normal;word-wrap:break-word}
  .grp{background:#e8edf7;color:#1e3a8a;font-weight:bold;font-size:11pt}
  .sub{background:#f4f6fa;color:#475569;font-style:italic;text-align:right;font-size:9pt}
  .t-title{font-size:17pt;font-weight:bold;color:#111827}
  .t-sub{font-size:9pt;color:#64748b}
  .sumt td{border:0.5pt solid #c9ced6}
  .sumk{background:#f8fafc;font-weight:bold;width:170px}
  .sumv{text-align:center;font-weight:bold;width:90px}
  .sumh{background:#2563eb;color:#fff;font-weight:bold;text-align:center}
</style></head><body>
<div class="t-title">${esc(title)} — StayOS Rapor</div>
<div class="t-sub">${esc(filterDesc().join('  ·  '))}</div>
<div class="t-sub">Oluşturulma: ${esc(fmtDateTR(todayStr()))}</div>
<br>
<table class="sumt"><tr><td class="sumh" colspan="2">ÖZET</td></tr>
${sumRows.map(([k, v]) => `<tr><td class="sumk">${esc(k)}</td><td class="sumv">${esc(v)}</td></tr>`).join('')}
</table>
<table><thead>${headTr}</thead><tbody>${body}</tbody></table>
</body></html>`;

        const blob = new Blob(['﻿', html], { type: 'application/vnd.ms-excel;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'StayOS_Rapor_' + todayStr() + '.xls';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('Excel raporu indirildi.');
    }

    // ── Print ──────────────────────────────────────────────────
    function printReport() {
        const rows = filtered();
        if (!rows.length) { toast('Bu rapor için veri yok.', true); return; }
        const s = summary(rows);
        const groups = grouped(rows);
        const title = $('repTitle').textContent;

        let body = '';
        for (const g of groups) {
            if (g.key !== '') body += `<tr><td class="grp" colspan="${COLS.length}">${esc(g.key)} — ${g.rows.length} kayıt</td></tr>`;
            for (const r of g.rows) {
                const vals = rowValues(r);
                body += '<tr>' + vals.map((v, i) => `<td class="${i === 6 || i === 7 ? 'wide' : ''}">${esc(v)}</td>`).join('') + '</tr>';
            }
        }
        const stats = [
            ['Toplam', s.total], ['Şikayet', s.complaint], ['Talep', s.request],
            ['Bekliyor', s.following], ['İşlemde', s.inprogress], ['Tamamlandı', s.solved],
            ['Geciken', s.overdue], ['Çözüm', '%' + s.solveRate]
        ];
        const w = window.open('', '_blank');
        if (!w) { toast('Açılır pencere engellendi.', true); return; }
        w.document.write(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>${esc(title)} — StayOS</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111827}
  h1{font-size:20px;margin:0 0 2px}
  .sub{font-size:11px;color:#64748b;margin-bottom:14px;line-height:1.5}
  .stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
  .stat{border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;min-width:90px}
  .stat b{display:block;font-size:18px}
  .stat span{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px}
  table{border-collapse:collapse;width:100%;font-size:10px}
  td,th{border:1px solid #d1d5db;padding:5px 7px;text-align:left;vertical-align:top}
  th{background:#111827;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:.4px}
  .grp{background:#e8edf7;color:#1e3a8a;font-weight:bold}
  .wide{max-width:240px}
  tr{page-break-inside:avoid}
  @media print{body{margin:10px}.noprint{display:none}}
</style></head><body>
<h1>${esc(title)} — StayOS Rapor</h1>
<div class="sub">${esc(filterDesc().join(' · '))}<br>Oluşturulma: ${esc(fmtDateTR(todayStr()))}</div>
<div class="stats">${stats.map(([l, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
<table><thead><tr>${COLS.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
<script>window.onload=function(){setTimeout(function(){window.print();},300);}<\/script>
</body></html>`);
        w.document.close();
    }

    // ── Build chips & selects ──────────────────────────────────
    function distinctDepts() {
        const set = new Set();
        (window.IssueConfig ? IssueConfig.departments() : []).forEach(d => set.add(d.name));
        records.forEach(r => { if (r.department) set.add(r.department); });
        return [...set].sort((a, b) => a.localeCompare(b, 'tr'));
    }
    function distinctTopics() {
        const set = new Set();
        (window.IssueConfig ? IssueConfig.topics() : []).forEach(t => set.add(t));
        records.forEach(r => { if ((r.type || 'complaint') === 'complaint' && r.topic) set.add(r.topic); });
        return [...set].sort((a, b) => a.localeCompare(b, 'tr'));
    }
    function distinctStaff() {
        const set = new Set();
        records.forEach(r => { if (r.staffInitial) set.add(r.staffInitial); });
        return [...set].sort((a, b) => a.localeCompare(b, 'tr'));
    }
    function distinctGuests() {
        const set = new Set();
        records.forEach(r => { if (r.guestName) set.add(r.guestName); });
        return [...set].sort((a, b) => a.localeCompare(b, 'tr'));
    }

    function chipHtml(values, activeSet) {
        return values.map(v => `<button data-v="${esc(v)}"${activeSet.has(v) ? ' class="active"' : ''}>${esc(v)}</button>`).join('');
    }
    function buildDynamic() {
        const depts = distinctDepts();
        $('repDepts').innerHTML = depts.length ? chipHtml(depts, F.depts) : '<span class="rep-none">Departman yok</span>';
        const topics = distinctTopics();
        $('repTopics').innerHTML = topics.length ? chipHtml(topics, F.topics) : '<span class="rep-none">Henüz konu yok</span>';
        const staff = distinctStaff();
        $('repStaff').innerHTML = '<option value="">Tümü</option>' + staff.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
        if (F.staff) $('repStaff').value = F.staff;
        $('repGuestList').innerHTML = distinctGuests().map(g => `<option value="${esc(g)}">`).join('');
        wireChipGroup('repDepts', F.depts);
        wireChipGroup('repTopics', F.topics);
    }
    function wireChipGroup(id, set) {
        const host = $(id); if (!host) return;
        host.querySelectorAll('button[data-v]').forEach(b => {
            b.onclick = () => {
                const v = b.getAttribute('data-v');
                if (set.has(v)) { set.delete(v); b.classList.remove('active'); }
                else { set.add(v); b.classList.add('active'); }
                render();
            };
        });
    }

    // ── Wire static controls ───────────────────────────────────
    function wire() {
        // type segmented
        $('repType').querySelectorAll('button').forEach(b => {
            b.onclick = () => {
                F.type = b.getAttribute('data-v');
                $('repType').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
                $('repTopicWrap').style.display = (F.type === 'request') ? 'none' : '';
                render();
            };
        });
        // date preset
        $('repDatePreset').onchange = e => {
            F.preset = e.target.value;
            $('repCustomDates').style.display = (F.preset === 'custom') ? '' : 'none';
            render();
        };
        $('repFrom').onchange = e => { F.from = e.target.value; render(); };
        $('repTo').onchange = e => { F.to = e.target.value; render(); };
        // status chips
        wireChipGroup('repStatus', F.statuses);
        // staff / room / guest / group
        $('repStaff').onchange = e => { F.staff = e.target.value; render(); };
        $('repRoom').oninput = e => { F.room = e.target.value; render(); };
        $('repGuest').oninput = e => { F.guest = e.target.value; render(); };
        $('repGroupBy').onchange = e => { F.groupBy = e.target.value; render(); };
        // reset
        $('repReset').onclick = () => {
            F.type = 'all'; F.preset = 'all'; F.from = ''; F.to = '';
            F.depts.clear(); F.topics.clear(); F.statuses.clear();
            F.staff = ''; F.room = ''; F.guest = ''; F.groupBy = 'none';
            $('repDatePreset').value = 'all'; $('repCustomDates').style.display = 'none';
            $('repStaff').value = ''; $('repRoom').value = ''; $('repGuest').value = '';
            $('repGroupBy').value = 'none'; $('repFrom').value = ''; $('repTo').value = '';
            $('repType').querySelectorAll('button').forEach(x => x.classList.toggle('active', x.getAttribute('data-v') === 'all'));
            $('repTopicWrap').style.display = '';
            $('repStatus').querySelectorAll('button').forEach(x => x.classList.remove('active'));
            buildDynamic(); render();
        };
        $('repExcel').onclick = exportExcel;
        $('repPrint').onclick = printReport;
    }

    // ── Boot ───────────────────────────────────────────────────
    function start() {
        wire();
        if (window.IssueConfig) {
            IssueConfig.load().then(() => { if (ready) buildDynamic(); });
            IssueConfig.listen(() => { if (ready) buildDynamic(); });
            IssueConfig.listenTopics(() => { if (ready) buildDynamic(); });
        }
        db.collection('guestLogs').where('tenantId', '==', TENANT_ID).orderBy('createdAt', 'desc').onSnapshot(snap => {
            records = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
            ready = true;
            buildDynamic();
            render();
        }, err => { console.error('reports load failed', err); toast('Kayıtlar yüklenemedi.', true); });
    }

    function boot() {
        if (typeof auth !== 'undefined' && auth.onAuthStateChanged) {
            auth.onAuthStateChanged(u => { if (u) start(); });
        } else { start(); }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
