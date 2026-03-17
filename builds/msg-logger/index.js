(function() {

    // ── State ────────────────────────────────────────────────────────────
    var ghostDeleted  = Object.create(null); // id -> {content, authorName, channelId, time}
    var editHistories = Object.create(null); // id -> [{content, time}, ...]
    var msgCache      = Object.create(null); // id -> {content, authorName, channelId, guildId}
    var cacheKeys     = [];
    var MAX_CACHE     = 2000;
    var _removeIntercept = null;
    var _unpatches    = [];

    // ── Cache ────────────────────────────────────────────────────────────

    function cacheMsg(msg) {
        if (!msg || !msg.id) return;
        var existing = msgCache[msg.id];
        if (existing) {
            if (msg.content) existing.content = msg.content;
            return;
        }
        msgCache[msg.id] = {
            content:    msg.content    || "",
            authorId:   msg.author ? (msg.author.id   || "?") : "?",
            authorName: msg.author ? (msg.author.global_name || msg.author.username || "Unknown") : "Unknown",
            channelId:  msg.channel_id || "?",
            guildId:    msg.guild_id   || null,
        };
        cacheKeys.push(msg.id);
        while (cacheKeys.length > MAX_CACHE) { delete msgCache[cacheKeys.shift()]; }
    }

    // ── Flux intercept ────────────────────────────────────────────────────
    // Raw _interceptors cb: return true to BLOCK the dispatch

    function onFluxRaw(payload) {
        try {
            if (payload.type === "MESSAGE_CREATE") {
                cacheMsg(payload.message);
            }

            else if (payload.type === "MESSAGE_UPDATE") {
                var msg = payload.message;
                if (!msg || !msg.id) return;
                var cached = msgCache[msg.id];
                var oldContent = cached ? cached.content : null;
                var newContent = msg.content;
                if (oldContent && newContent && oldContent !== newContent) {
                    if (!editHistories[msg.id]) editHistories[msg.id] = [];
                    editHistories[msg.id].push({ content: oldContent, time: Date.now() });
                    if (editHistories[msg.id].length > 10) editHistories[msg.id].shift();
                }
                cacheMsg(msg);
            }

            else if (payload.type === "MESSAGE_DELETE") {
                var id = payload.id;
                var c  = msgCache[id];
                if (c && c.content) {
                    ghostDeleted[id] = {
                        content:    c.content,
                        authorName: c.authorName,
                        channelId:  c.channelId,
                        guildId:    c.guildId,
                        time:       Date.now(),
                    };
                    // Block the delete so message stays in the channel
                    return true;
                }
            }

            else if (payload.type === "MESSAGE_DELETE_BULK") {
                var ids = payload.ids || [];
                var anyGhosted = false;
                for (var i = 0; i < ids.length; i++) {
                    var c2 = msgCache[ids[i]];
                    if (c2 && c2.content) {
                        ghostDeleted[ids[i]] = {
                            content:    c2.content,
                            authorName: c2.authorName,
                            channelId:  c2.channelId,
                            guildId:    c2.guildId,
                            bulk:       true,
                            time:       Date.now(),
                        };
                        anyGhosted = true;
                    }
                }
                // Block bulk delete for any ghosted message
                if (anyGhosted) return true;
            }
        } catch(e) {}
    }

    // ── Patch message component ───────────────────────────────────────────
    // We patch whatever renders message content to:
    //  1. Overlay a red tint + "DELETED" badge on ghost-deleted messages
    //  2. Show an edit history expander under edited messages

    function patchMessages() {
        var RN   = vendetta.metro.common.ReactNative;
        var R    = vendetta.metro.common.React;
        var h    = R.createElement;

        // Try multiple known prop combos Discord has used for the message content wrapper
        var propCombos = [
            ["renderContent", "renderEmbeds"],
            ["renderContent", "renderAttachments"],
            ["getMessageId",  "renderContent"],
            ["message",       "renderContent"],
        ];

        var mod = null;
        var renderKey = null;
        for (var i = 0; i < propCombos.length; i++) {
            var candidate = vendetta.metro.findByProps.apply(null, propCombos[i]);
            if (candidate) {
                // find which exported key is the component/function
                var keys = Object.keys(candidate);
                for (var j = 0; j < keys.length; j++) {
                    if (typeof candidate[keys[j]] === "function" && /message|content|chat/i.test(keys[j])) {
                        mod = candidate; renderKey = keys[j]; break;
                    }
                }
                if (mod) break;
            }
        }

        // Fallback: find by display name
        if (!mod) {
            var byName = vendetta.metro.findByDisplayName("MessageContent");
            if (byName && typeof byName === "function") {
                mod = { MessageContent: byName }; renderKey = "MessageContent";
            }
        }

        if (!mod || !renderKey) return false;

        var unpatch = vendetta.patcher.after(renderKey, mod, function(args, ret) {
            // Extract message id from args or the first arg's props
            var msgId = null;
            try {
                var firstArg = args[0];
                msgId = (firstArg && (firstArg.messageId || (firstArg.message && firstArg.message.id) || firstArg.id));
            } catch(e) {}
            if (!msgId) return;

            var tokens = vendetta.metro.findByProps("unsafe_rawColors","colors");
            var colors = tokens && tokens.colors;
            var C = {
                red:    "#ed4245",
                gold:   "#fee75c",
                goldD:  "#b8960c",
                muted:  (colors && colors.TEXT_MUTED) || "#72767d",
                text:   (colors && colors.TEXT_NORMAL)|| "#dcddde",
                bgDeep: (colors && colors.BACKGROUND_TERTIARY) || "#202225",
            };

            var overlays = [];

            // Deleted ghost overlay
            if (ghostDeleted[msgId]) {
                overlays.push(
                    h(RN.View, {
                        key: "del-badge",
                        style: { flexDirection:"row", alignItems:"center", marginTop:4,
                                 backgroundColor: C.red+"18", borderRadius:4,
                                 paddingHorizontal:6, paddingVertical:2,
                                 borderLeftWidth:2, borderLeftColor:C.red+"88",
                                 alignSelf:"flex-start" }
                    },
                        h(RN.Text, { style: { color:C.red, fontSize:11, fontWeight:"700", letterSpacing:0.5 } }, "🗑 DELETED")
                    )
                );
            }

            // Edit history expander
            if (editHistories[msgId] && editHistories[msgId].length > 0) {
                var ExpandedEdits = (function() {
                    var localMsgId = msgId;
                    return function() {
                        var expanded = R.useState(false);
                        var open = expanded[0]; var setOpen = expanded[1];
                        var history = editHistories[localMsgId] || [];
                        return h(RN.View, { style: { marginTop:4 } },
                            h(RN.TouchableOpacity, {
                                onPress: function() { setOpen(!open); },
                                activeOpacity: 0.7,
                                style: { flexDirection:"row", alignItems:"center",
                                         alignSelf:"flex-start", paddingVertical:2,
                                         paddingHorizontal:6, borderRadius:4,
                                         backgroundColor: C.gold+"18",
                                         borderLeftWidth:2, borderLeftColor:C.gold+"88" }
                            },
                                h(RN.Text, { style:{ color:C.goldD, fontSize:11, fontWeight:"700" } },
                                    (open ? "▲" : "▼") + " " + history.length + " edit" + (history.length!==1?"s":"") + " — tap to " + (open?"hide":"show"))
                            ),
                            open && h(RN.View, { style: { marginTop:4 } },
                                history.slice().reverse().map(function(edit, idx) {
                                    return h(RN.View, {
                                        key: String(idx),
                                        style: { backgroundColor:C.bgDeep, borderRadius:6, padding:8,
                                                 marginBottom:4, borderLeftWidth:2, borderLeftColor:C.gold+"88" }
                                    },
                                        h(RN.Text, { style:{ color:C.muted, fontSize:10, marginBottom:3 } },
                                            "version " + (history.length - idx) + "  •  " + new Date(edit.time).toLocaleTimeString()),
                                        h(RN.Text, { style:{ color:C.text, fontSize:13, lineHeight:18 } }, edit.content)
                                    );
                                })
                            )
                        );
                    };
                })();

                overlays.push(h(ExpandedEdits, { key: "edits" }));
            }

            if (!overlays.length) return;

            // Wrap the original return value + our overlays in a fragment
            if (!ret) return h(RN.View, null, overlays);
            return h(RN.View, null, ret, overlays);
        });

        _unpatches.push(unpatch);
        return true;
    }

    // ── Plugin lifecycle ──────────────────────────────────────────────────

    return {
        onLoad: function() {
            // Flux intercept via raw _interceptors
            var FD = vendetta.metro.findByProps("_interceptors");
            if (FD && Array.isArray(FD._interceptors)) {
                FD._interceptors.push(onFluxRaw);
                _removeIntercept = function() {
                    FD._interceptors = FD._interceptors.filter(function(fn){ return fn !== onFluxRaw; });
                };
            }

            // Patch message renderer
            patchMessages();
        },

        onUnload: function() {
            _unpatches.forEach(function(u){ try { u && u(); } catch(e){} });
            _unpatches = [];
            if (_removeIntercept) { try { _removeIntercept(); } catch(e){} _removeIntercept = null; }
            ghostDeleted  = Object.create(null);
            editHistories = Object.create(null);
            msgCache      = Object.create(null);
            cacheKeys     = [];
        },

        settings: function() {
            var R  = vendetta.metro.common.React;
            var RN = vendetta.metro.common.ReactNative;
            var h  = R.createElement;
            var tokens = vendetta.metro.findByProps("unsafe_rawColors","colors");
            var C = { muted: (tokens&&tokens.colors&&tokens.colors.TEXT_MUTED)||"#72767d", text: (tokens&&tokens.colors&&tokens.colors.TEXT_NORMAL)||"#dcddde" };
            var ghostCount = Object.keys(ghostDeleted).length;
            var editCount  = Object.keys(editHistories).length;
            return h(RN.View, { style:{ padding:20 } },
                h(RN.Text, { style:{ color:C.text, fontSize:18, fontWeight:"700", marginBottom:8 } }, "Message Logger"),
                h(RN.Text, { style:{ color:C.muted, fontSize:14, marginBottom:4 } }, "Deleted messages stay visible in chat with a 🗑 DELETED badge."),
                h(RN.Text, { style:{ color:C.muted, fontSize:14, marginBottom:16 } }, "Edited messages show a tap-to-expand edit history under them."),
                h(RN.Text, { style:{ color:C.muted, fontSize:13 } }, "Currently tracking:"),
                h(RN.Text, { style:{ color:"#ed4245", fontSize:13, marginTop:4 } }, "  🗑  " + ghostCount + " ghost-deleted message" + (ghostCount!==1?"s":"")),
                h(RN.Text, { style:{ color:"#fee75c", fontSize:13, marginTop:4 } }, "  ✏️  " + editCount + " message" + (editCount!==1?"s":"") + " with edit history")
            );
        },
    };
})()
