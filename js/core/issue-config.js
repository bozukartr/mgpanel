/* StayOS — Shared issue (department + topic) configuration.
 *
 * One Firestore doc per hotel: issueConfig/{tenantId} = {
 *   tenantId, departments: [{ name, kind: 'both'|'request'|'complaint', topics: [..] }], updatedAt
 * }
 *
 * A single list of departments with a "kind" tag decides where each one shows
 * up (talep / şikayet / her ikisi). Topics are an optional sub-category used to
 * group complaints (and to make "tekrarlayan sorun" detection precise).
 *
 * Loaded on panel.html, panel-mobile.html and admin.html before the modules
 * that consume it. Falls back to a 5-department Turkish default set when the
 * hotel hasn't customized anything yet.
 */
(function (global) {
    'use strict';

    var COL = 'issueConfig';

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
    var readyCbs = [];

    function normalize(list) {
        if (!Array.isArray(list)) return [];
        return list.map(function (d) {
            d = d || {};
            return {
                name: String(d.name || '').trim(),
                kind: (d.kind === 'request' || d.kind === 'complaint') ? d.kind : 'both'
            };
        }).filter(function (d) { return d.name; });
    }

    function flush() {
        var cbs = readyCbs.slice();
        readyCbs = [];
        cbs.forEach(function (c) { try { c(); } catch (e) {} });
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
                if (typeof cb === 'function') { try { cb(self.departments()); } catch (e) {} }
            }, function () {});
        }
    };

    global.IssueConfig = IssueConfig;
})(window);
