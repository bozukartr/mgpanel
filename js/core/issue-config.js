/* Hotizy — Shared issue (department + topic) configuration.
 *
 * One Firestore doc per hotel: issueConfig/{tenantId} = {
 *   tenantId, departments: [{ name, kind: 'both'|'request'|'complaint', topics: [..] }], updatedAt
 * }
 *
 * A single list of departments with a "kind" tag decides where each one shows
 * up (talep / şikayet / her ikisi). Topics are an optional sub-category used to
 * group complaints (and to make "tekrarlayan sorun" detection precise).
 *
 * Loaded on panel.html and admin.html before the modules
 * that consume it. Falls back to a 5-department Turkish default set when the
 * hotel hasn't customized anything yet.
 */
(function (global) {
    'use strict';

    var COL = 'issueConfig';
    var TOPIC_COL = 'issueTopics';

    // Default starter departments (Turkish). kind: 'both' — each hotel customizes.
    // Topics are NOT defined here: konu is entered manually per complaint and the
    // suggestion list is built dynamically from previously-used topics.
    var DEFAULT_DEPTS = [
        { name: 'Kat Hizmetleri', kind: 'both' },
        { name: 'Ön Büro', kind: 'both' },
        { name: 'Teknik', kind: 'both' },
        { name: 'Mutfak', kind: 'both' },
        { name: 'Yiyecek & İçecek', kind: 'both' }
    ];

    var state = { departments: null, loaded: false };
    var topicState = []; // [{ id, name }]
    var readyCbs = [];

    var DEFAULT_SLA = 15; // dakika — departmana özel sla yoksa varsayılan eşik

    function normalize(list) {
        if (!Array.isArray(list)) return [];
        return list.map(function (d) {
            d = d || {};
            var n = Number(d.sla);
            var out = {
                name: String(d.name || '').trim(),
                kind: (d.kind === 'request' || d.kind === 'complaint') ? d.kind : 'both'
            };
            if (isFinite(n) && n > 0) out.sla = Math.round(n); // tanımsız/0/negatif → alan yok (varsayılana düşer)
            return out;
        }).filter(function (d) { return d.name; });
    }

    function flush() {
        var cbs = readyCbs.slice();
        readyCbs = [];
        cbs.forEach(function (c) { try { c(); } catch (e) { if (window.Monitor) Monitor.capture(e, { where: 'IssueConfig.flush' }); } });
    }

    var IssueConfig = {
        DEFAULTS: DEFAULT_DEPTS,

        // Current departments — saved config if any, otherwise the defaults.
        departments: function () {
            return (state.departments && state.departments.length)
                ? state.departments
                : normalize(DEFAULT_DEPTS);
        },

        // Departments applicable to a record type ('request' | 'complaint').
        departmentsFor: function (type) {
            var t = (type === 'request') ? 'request' : 'complaint';
            return this.departments().filter(function (d) {
                return d.kind === 'both' || d.kind === t;
            });
        },

        // SLA (dakika) — departmana özel; tanımsızsa varsayılan eşik.
        defaultSla: function () { return DEFAULT_SLA; },
        slaFor: function (deptName) {
            var key = String(deptName || '').trim().toLowerCase();
            var found = this.departments().filter(function (d) { return d.name.toLowerCase() === key; })[0];
            return (found && found.sla > 0) ? found.sla : DEFAULT_SLA;
        },

        isLoaded: function () { return state.loaded; },

        onReady: function (cb) {
            if (typeof cb !== 'function') return;
            if (state.loaded) cb(); else readyCbs.push(cb);
        },

        // One-shot fetch.
        load: function () {
            var self = this;
            if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') {
                state.loaded = true; flush();
                return Promise.resolve(self.departments());
            }
            return db.collection(COL).doc(TENANT_ID).get().then(function (doc) {
                var data = doc.exists ? doc.data() : null;
                if (data && Array.isArray(data.departments)) state.departments = normalize(data.departments);
                state.loaded = true; flush();
                return self.departments();
            }).catch(function () {
                state.loaded = true; flush();
                return self.departments();
            });
        },

        // Live updates so admin edits reflect in open panels without a reload.
        listen: function (cb) {
            var self = this;
            if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') return function () {};
            return db.collection(COL).doc(TENANT_ID).onSnapshot(function (doc) {
                var data = doc.exists ? doc.data() : null;
                state.departments = (data && Array.isArray(data.departments)) ? normalize(data.departments) : null;
                state.loaded = true; flush();
                if (typeof cb === 'function') { try { cb(self.departments()); } catch (e) { if (window.Monitor) Monitor.capture(e, { where: 'IssueConfig.listen' }); } }
            }, function () {});
        },

        // ── Konular (topics) ───────────────────────────────────
        // Topics are stored as one doc per topic in the `issueTopics` collection
        // (tenant-scoped). Any staff member may add one while logging a complaint;
        // only an admin can delete. This makes the list curatable (list / delete)
        // instead of a value derived from records.
        topics: function () {
            return topicState.map(function (t) { return t.name; });
        },
        // [{ id, name }] — for the admin management list.
        topicEntries: function () {
            return topicState.slice();
        },
        listenTopics: function (cb) {
            if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') return function () {};
            return db.collection(TOPIC_COL).where('tenantId', '==', TENANT_ID).onSnapshot(function (snap) {
                topicState = snap.docs.map(function (d) {
                    return { id: d.id, name: String((d.data() || {}).name || '').trim() };
                }).filter(function (t) { return t.name; })
                    .sort(function (a, b) { return a.name.localeCompare(b.name, 'tr'); });
                if (typeof cb === 'function') { try { cb(topicState.slice()); } catch (e) { if (window.Monitor) Monitor.capture(e, { where: 'IssueConfig.listenTopics' }); } }
            }, function () {});
        },
        // Persist a typed topic if it isn't already known (case-insensitive).
        addTopic: function (name) {
            name = String(name || '').trim();
            if (!name) return Promise.resolve();
            if (typeof db === 'undefined' || typeof TENANT_ID === 'undefined') return Promise.resolve();
            var key = name.toLowerCase();
            if (topicState.some(function (t) { return t.name.toLowerCase() === key; })) return Promise.resolve();
            return db.collection(TOPIC_COL).add({
                tenantId: TENANT_ID,
                name: name,
                createdAt: (firebase && firebase.firestore) ? firebase.firestore.FieldValue.serverTimestamp() : null
            }).catch(function () {});
        },
        deleteTopic: function (id) {
            if (!id || typeof db === 'undefined') return Promise.resolve();
            return db.collection(TOPIC_COL).doc(id).delete();
        }
    };

    global.IssueConfig = IssueConfig;
})(window);
