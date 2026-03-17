// ============================================================
//  MessageLogger  v1.0.0  –  Kettu/Bunny plugin
//  Logs deleted & edited messages. Open Plugin Settings to view.
//
//  Architecture:
//   1. Flux intercept on MESSAGE_CREATE caches last 1000 messages
//   2. MESSAGE_UPDATE  → diff against cache → log edit
//   3. MESSAGE_DELETE / MESSAGE_DELETE_BULK → lookup cache → log delete
//   4. SettingsComponent renders a scrollable log viewer
// ============================================================

// ── State ─────────────────────────────────────────────────────────────────

var _storage = null;       // bunny.plugin.createStorage() proxy
var _unpatch = null;       // flux intercept disposer

var msgCache  = Object.create(null); // msgId → CacheEntry
var cacheKeys = [];                  // insertion-order keys for LRU eviction

var MAX_CACHE = 1000;
var MAX_LOGS  = 500;

// ── Utils ──────────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, "0"); }

function fmtTime(ms) {
    var d = new Date(ms);
    return (d.getMonth() + 1) + "/" + d.getDate()
        + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function fmtRelative(ms) {
    var diff = Date.now() - ms;
    if (diff < 60000)    return Math.floor(diff / 1000) + "s ago";
    if (diff < 3600000)  return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return Math.floor(diff / 86400000) + "d ago";
}

// ── Cache ──────────────────────────────────────────────────────────────────

function cacheSet(msg) {
    if (!msg || !msg.id) return;
    // Only cache if there's actual text content (skip embeds-only / empty)
    if (!msg.content) return;

    if (msgCache[msg.id]) {
        msgCache[msg.id].content = msg.content; // update existing
        return;
    }

    msgCache[msg.id] = {
        content:    msg.content,
        authorId:   (msg.author && msg.author.id)   || "?",
        authorName: (msg.author && (msg.author.global_name || msg.author.username)) || "Unknown",
        channelId:  msg.channel_id || "?",
        guildId:    msg.guild_id   || null,
    };
    cacheKeys.push(msg.id);

    // Evict oldest entries when cache is full
    while (cacheKeys.length > MAX_CACHE) {
        var evicted = cacheKeys.shift();
        delete msgCache[evicted];
    }
}

function cacheUpdate(msg) {
    if (!msg || !msg.id || !msg.content) return;
    var entry = msgCache[msg.id];
    if (entry) entry.content = msg.content;
    else cacheSet(msg);
}

// ── Log ───────────────────────────────────────────────────────────────────

function addLog(entry) {
    if (!_storage) return;
    var logs = _storage.logs;
    if (!Array.isArray(logs)) {
        _storage.logs = [];
        logs = _storage.logs;
    }
    logs.unshift(entry);
    if (logs.length > MAX_LOGS) logs.splice(MAX_LOGS);
}

// ── Flux handler ───────────────────────────────────────────────────────────

function onFlux(payload) {
    switch (payload.type) {

        case "MESSAGE_CREATE": {
            cacheSet(payload.message);
            break;
        }

        case "MESSAGE_UPDATE": {
            var msg = payload.message;
            if (!msg || !msg.id || !msg.content) break;
            var cached = msgCache[msg.id];
            if (cached && cached.content && cached.content !== msg.content) {
                addLog({
                    type:         "edit",
                    msgId:        msg.id,
                    channelId:    msg.channel_id || cached.channelId,
                    guildId:      msg.guild_id   || cached.guildId,
                    authorId:     cached.authorId,
                    authorName:   cached.authorName,
                    content:      cached.content,       // before
                    editedContent: msg.content,          // after
                    time:         Date.now(),
                });
            }
            cacheUpdate(msg);
            break;
        }

        case "MESSAGE_DELETE": {
            var cached = msgCache[payload.id];
            if (!cached || !cached.content) break;
            addLog({
                type:       "delete",
                msgId:      payload.id,
                channelId:  payload.channelId || cached.channelId,
                guildId:    payload.guildId   || cached.guildId,
                authorId:   cached.authorId,
                authorName: cached.authorName,
                content:    cached.content,
                time:       Date.now(),
            });
            delete msgCache[payload.id];
            break;
        }

        case "MESSAGE_DELETE_BULK": {
            var ids = payload.ids || [];
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                var cached = msgCache[id];
                if (!cached || !cached.content) continue;
                addLog({
                    type:       "delete",
                    msgId:      id,
                    channelId:  payload.channelId || cached.channelId,
                    guildId:    cached.guildId,
                    authorId:   cached.authorId,
                    authorName: cached.authorName,
                    content:    cached.content,
                    bulk:       true,
                    time:       Date.now(),
                });
                delete msgCache[id];
            }
            break;
        }
    }
}

// ── Settings UI ────────────────────────────────────────────────────────────

function SettingsComponent() {
    var R   = window.React;
    var RN  = window.ReactNative;
    var h   = R.createElement;
    var useState   = R.useState;
    var useReducer = R.useReducer;
    var useCallback = R.useCallback;

    // 0 = All, 1 = Deleted, 2 = Edited
    var tabArr    = useState(0);
    var tab       = tabArr[0], setTab = tabArr[1];
    var tickArr   = useReducer(function(x) { return x + 1; }, 0);
    var forceUpdate = tickArr[1];

    // Grab Discord design tokens for theming
    var tokens   = bunny.metro.findByProps("unsafe_rawColors", "colors");
    var C = {
        text:        (tokens && tokens.colors && tokens.colors.TEXT_NORMAL)       || "#dcddde",
        muted:       (tokens && tokens.colors && tokens.colors.TEXT_MUTED)        || "#72767d",
        bg:          (tokens && tokens.colors && tokens.colors.BACKGROUND_SECONDARY)    || "#2f3136",
        bgDeep:      (tokens && tokens.colors && tokens.colors.BACKGROUND_TERTIARY)     || "#202225",
        bgPrimary:   (tokens && tokens.colors && tokens.colors.BACKGROUND_PRIMARY)      || "#36393f",
        brand:       "#5865f2",
        delete:      "#ed4245",
        edit:        "#fee75c",
        editDark:    "#b8960c",
    };

    var logs = (_storage && Array.isArray(_storage.logs)) ? _storage.logs : [];
    var counts = {
        all:     logs.length,
        delete:  logs.filter(function(l) { return l.type === "delete"; }).length,
        edit:    logs.filter(function(l) { return l.type === "edit"; }).length,
    };

    var filtered = tab === 0 ? logs
        : tab === 1 ? logs.filter(function(l) { return l.type === "delete"; })
        : logs.filter(function(l) { return l.type === "edit"; });

    var doClear = useCallback(function() {
        if (_storage) _storage.logs = [];
        forceUpdate();
    }, []);

    var doCopy = useCallback(function(entry) {
        var text = entry.type === "edit"
            ? "[BEFORE] " + entry.content + "\n[AFTER]  " + entry.editedContent
            : entry.content;
        try { RN.Clipboard.setString(text); } catch(_) {
            try { bunny.metro.findByProps("setString").setString(text); } catch(__) {}
        }
        try { bunny.ui.toasts.showToast("Copied to clipboard"); } catch(_) {}
    }, []);

    // ── Tab bar ────────────────────────────────────────────────────────────

    var tabBar = h(RN.View, {
        style: {
            flexDirection: "row",
            marginHorizontal: 12,
            marginTop: 12,
            marginBottom: 8,
            backgroundColor: C.bgDeep,
            borderRadius: 10,
            padding: 3,
        }
    }, [
        ["All", counts.all],
        ["Deleted", counts.delete],
        ["Edited", counts.edit],
    ].map(function(pair, i) {
        var label = pair[0], count = pair[1];
        var active = tab === i;
        var accent = i === 1 ? C.delete : i === 2 ? C.edit : C.brand;
        return h(RN.TouchableOpacity, {
            key: i,
            onPress: function() { setTab(i); },
            activeOpacity: 0.8,
            style: {
                flex: 1,
                alignItems: "center",
                paddingVertical: 9,
                borderRadius: 8,
                backgroundColor: active ? (i === 0 ? C.brand : accent + (i === 2 ? "44" : "33")) : "transparent",
                borderWidth: active && i !== 0 ? 1 : 0,
                borderColor: active ? accent + "66" : "transparent",
            }
        },
            h(RN.Text, {
                style: {
                    color: active ? (i === 2 ? C.editDark : "#fff") : C.muted,
                    fontWeight: active ? "700" : "500",
                    fontSize: 13,
                }
            }, label),
            h(RN.View, {
                style: {
                    marginTop: 2,
                    backgroundColor: active ? (i === 2 ? C.editDark + "44" : "#ffffff33") : C.bgPrimary,
                    borderRadius: 10,
                    paddingHorizontal: 7,
                    paddingVertical: 1,
                }
            },
                h(RN.Text, {
                    style: {
                        color: active ? (i === 2 ? C.editDark : "#fff") : C.muted,
                        fontSize: 11,
                        fontWeight: "600",
                    }
                }, String(count))
            )
        );
    }));

    // ── Clear button ───────────────────────────────────────────────────────

    var clearBtn = logs.length > 0 && h(RN.TouchableOpacity, {
        onPress: doClear,
        activeOpacity: 0.75,
        style: {
            marginHorizontal: 12,
            marginBottom: 10,
            backgroundColor: C.delete + "18",
            borderRadius: 8,
            paddingVertical: 9,
            alignItems: "center",
            flexDirection: "row",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: C.delete + "44",
        }
    },
        h(RN.Text, { style: { color: C.delete, fontWeight: "600", fontSize: 13 } },
            "Clear " + filtered.length + " " + (tab === 0 ? "log" : tab === 1 ? "deleted" : "edited") + (filtered.length !== 1 ? "s" : "")
        )
    );

    // ── Empty state ────────────────────────────────────────────────────────

    var emptyView = h(RN.View, {
        style: { alignItems: "center", paddingTop: 80 }
    },
        h(RN.Text, { style: { fontSize: 38, marginBottom: 12 } }, tab === 1 ? "🗑️" : tab === 2 ? "✏️" : "👁️"),
        h(RN.Text, { style: { color: C.muted, fontSize: 16, fontWeight: "600" } }, "Nothing logged yet"),
        h(RN.Text, { style: { color: C.muted, fontSize: 13, marginTop: 6, textAlign: "center", paddingHorizontal: 30 } },
            tab === 1 ? "Deleted messages will appear here once seen."
                      : tab === 2 ? "Edited messages will appear here once seen."
                      : "Send some messages first so they get cached."
        )
    );

    // ── Log entry ──────────────────────────────────────────────────────────

    function renderEntry(entry, idx) {
        var isDel  = entry.type === "delete";
        var accent = isDel ? C.delete : C.edit;
        var tag    = isDel ? (entry.bulk ? "BULK DEL" : "DELETED") : "EDITED";

        return h(RN.TouchableOpacity, {
            key: entry.msgId + "_" + idx,
            onLongPress: function() { doCopy(entry); },
            activeOpacity: 0.85,
            style: {
                backgroundColor: C.bg,
                borderRadius: 10,
                marginBottom: 8,
                overflow: "hidden",
            }
        },
            // Accent strip
            h(RN.View, {
                style: {
                    height: 3,
                    backgroundColor: accent,
                }
            }),
            // Body
            h(RN.View, { style: { padding: 12 } },
                // Header row
                h(RN.View, {
                    style: { flexDirection: "row", alignItems: "center", marginBottom: 8 }
                },
                    // Tag pill
                    h(RN.View, {
                        style: {
                            backgroundColor: accent + "25",
                            borderRadius: 5,
                            paddingHorizontal: 7,
                            paddingVertical: 3,
                            marginRight: 8,
                            borderWidth: 1,
                            borderColor: accent + "55",
                        }
                    },
                        h(RN.Text, {
                            style: { color: accent, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 }
                        }, tag)
                    ),
                    // Author
                    h(RN.Text, {
                        style: { color: C.text, fontSize: 14, fontWeight: "700", flex: 1 },
                        numberOfLines: 1,
                    }, entry.authorName || "Unknown"),
                    // Time
                    h(RN.View, { style: { alignItems: "flex-end" } },
                        h(RN.Text, { style: { color: C.muted, fontSize: 11 } }, fmtTime(entry.time)),
                        h(RN.Text, { style: { color: C.muted, fontSize: 10 } }, fmtRelative(entry.time))
                    )
                ),
                // Channel/guild info
                h(RN.Text, {
                    style: { color: C.muted, fontSize: 11, marginBottom: 10, fontFamily: "monospace" }
                }, "#" + (entry.channelId || "?") + (entry.guildId ? ("  •  " + entry.guildId) : "  •  DM")),

                // Content area
                isDel
                    ? h(RN.View, {
                        style: {
                            backgroundColor: C.bgDeep,
                            borderRadius: 8,
                            padding: 10,
                            borderLeftWidth: 2,
                            borderLeftColor: C.delete + "88",
                        }
                    },
                        h(RN.Text, {
                            style: { color: C.text, fontSize: 14, lineHeight: 20 }
                        }, entry.content || "(empty)")
                    )
                    : h(RN.View, null,
                        // BEFORE
                        h(RN.View, {
                            style: {
                                backgroundColor: C.bgDeep,
                                borderRadius: 8,
                                padding: 10,
                                marginBottom: 6,
                                borderLeftWidth: 2,
                                borderLeftColor: C.delete + "88",
                            }
                        },
                            h(RN.Text, { style: { color: C.delete, fontSize: 10, fontWeight: "700", marginBottom: 4, letterSpacing: 0.6 } }, "BEFORE"),
                            h(RN.Text, { style: { color: C.text, fontSize: 14, lineHeight: 20 } }, entry.content || "(empty)")
                        ),
                        // AFTER
                        h(RN.View, {
                            style: {
                                backgroundColor: C.bgDeep,
                                borderRadius: 8,
                                padding: 10,
                                borderLeftWidth: 2,
                                borderLeftColor: C.edit + "88",
                            }
                        },
                            h(RN.Text, { style: { color: C.editDark, fontSize: 10, fontWeight: "700", marginBottom: 4, letterSpacing: 0.6 } }, "AFTER"),
                            h(RN.Text, { style: { color: C.text, fontSize: 14, lineHeight: 20 } }, entry.editedContent || "(empty)")
                        )
                    ),
                // Long-press hint
                h(RN.Text, {
                    style: { color: C.muted, fontSize: 10, marginTop: 8, textAlign: "right" }
                }, "long press to copy")
            )
        );
    }

    // ── Root ───────────────────────────────────────────────────────────────

    return h(RN.View, { style: { flex: 1, backgroundColor: C.bgPrimary } },
        tabBar,
        clearBtn,
        h(RN.ScrollView, {
            style: { flex: 1, paddingHorizontal: 12 },
            contentContainerStyle: { paddingBottom: 24 },
            showsVerticalScrollIndicator: false,
        },
            filtered.length === 0
                ? emptyView
                : filtered.map(renderEntry)
        )
    );
}

// ── Plugin entry ───────────────────────────────────────────────────────────

var plugin = definePlugin({
    start: function() {
        _storage = bunny.plugin.createStorage();
        if (!Array.isArray(_storage.logs)) _storage.logs = [];

        _unpatch = bunny.api.flux.intercept(onFlux);
        bunny.plugin.logger.info("MessageLogger: started, watching events");
    },

    stop: function() {
        if (_unpatch) { _unpatch(); _unpatch = null; }
        msgCache   = Object.create(null);
        cacheKeys  = [];
        _storage   = null;
        bunny.plugin.logger.info("MessageLogger: stopped");
    },

    SettingsComponent: SettingsComponent,
});
