var _storage = null;
var _unpatch = null;
var msgCache  = Object.create(null);
var cacheKeys = [];
var MAX_CACHE = 1000;
var MAX_LOGS  = 500;

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtTime(ms) {
    var d = new Date(ms);
    return (d.getMonth()+1)+"/"+d.getDate()+" "+pad2(d.getHours())+":"+pad2(d.getMinutes())+":"+pad2(d.getSeconds());
}
function fmtRelative(ms) {
    var diff = Date.now() - ms;
    if (diff < 60000)    return Math.floor(diff/1000)+"s ago";
    if (diff < 3600000)  return Math.floor(diff/60000)+"m ago";
    if (diff < 86400000) return Math.floor(diff/3600000)+"h ago";
    return Math.floor(diff/86400000)+"d ago";
}

function cacheSet(msg) {
    if (!msg || !msg.id || !msg.content) return;
    if (msgCache[msg.id]) { msgCache[msg.id].content = msg.content; return; }
    msgCache[msg.id] = {
        content:    msg.content,
        authorId:   (msg.author && msg.author.id)   || "?",
        authorName: (msg.author && (msg.author.global_name || msg.author.username)) || "Unknown",
        channelId:  msg.channel_id || "?",
        guildId:    msg.guild_id   || null,
    };
    cacheKeys.push(msg.id);
    while (cacheKeys.length > MAX_CACHE) { delete msgCache[cacheKeys.shift()]; }
}

function addLog(entry) {
    if (!_storage) return;
    if (!Array.isArray(_storage.logs)) _storage.logs = [];
    _storage.logs.unshift(entry);
    if (_storage.logs.length > MAX_LOGS) _storage.logs.splice(MAX_LOGS);
}

function onFlux(payload) {
    switch (payload.type) {
        case "MESSAGE_CREATE":
            cacheSet(payload.message);
            break;
        case "MESSAGE_UPDATE": {
            var msg = payload.message;
            if (!msg || !msg.id || !msg.content) break;
            var cached = msgCache[msg.id];
            if (cached && cached.content && cached.content !== msg.content) {
                addLog({ type:"edit", msgId:msg.id, channelId:msg.channel_id||cached.channelId, guildId:msg.guild_id||cached.guildId, authorId:cached.authorId, authorName:cached.authorName, content:cached.content, editedContent:msg.content, time:Date.now() });
            }
            cacheSet(msg);
            break;
        }
        case "MESSAGE_DELETE": {
            var c = msgCache[payload.id];
            if (!c || !c.content) break;
            addLog({ type:"delete", msgId:payload.id, channelId:payload.channelId||c.channelId, guildId:payload.guildId||c.guildId, authorId:c.authorId, authorName:c.authorName, content:c.content, time:Date.now() });
            delete msgCache[payload.id];
            break;
        }
        case "MESSAGE_DELETE_BULK": {
            var ids = payload.ids || [];
            for (var i = 0; i < ids.length; i++) {
                var c2 = msgCache[ids[i]];
                if (!c2 || !c2.content) continue;
                addLog({ type:"delete", msgId:ids[i], channelId:payload.channelId||c2.channelId, guildId:c2.guildId, authorId:c2.authorId, authorName:c2.authorName, content:c2.content, bulk:true, time:Date.now() });
                delete msgCache[ids[i]];
            }
            break;
        }
    }
}

// ── Settings UI ───────────────────────────────────────────────────────────

function SettingsComponent() {
    var R  = vendetta.metro.common.React;
    var RN = vendetta.metro.common.ReactNative;
    var h  = R.createElement;
    var useState    = R.useState;
    var useReducer  = R.useReducer;
    var useCallback = R.useCallback;

    var tabState = useState(0); var tab = tabState[0]; var setTab = tabState[1];
    var tickState = useReducer(function(x){return x+1;},0); var forceUpdate = tickState[1];

    var tokens = vendetta.metro.findByProps("unsafe_rawColors","colors");
    var C = {
        text:       (tokens&&tokens.colors&&tokens.colors.TEXT_NORMAL)||"#dcddde",
        muted:      (tokens&&tokens.colors&&tokens.colors.TEXT_MUTED)||"#72767d",
        bg:         (tokens&&tokens.colors&&tokens.colors.BACKGROUND_SECONDARY)||"#2f3136",
        bgDeep:     (tokens&&tokens.colors&&tokens.colors.BACKGROUND_TERTIARY)||"#202225",
        bgPrimary:  (tokens&&tokens.colors&&tokens.colors.BACKGROUND_PRIMARY)||"#36393f",
        brand:      "#5865f2", delete_: "#ed4245", edit_: "#fee75c", editDark: "#b8960c",
    };

    var logs = (_storage && Array.isArray(_storage.logs)) ? _storage.logs : [];
    var counts = { all:logs.length, del:logs.filter(function(l){return l.type==="delete";}).length, edit:logs.filter(function(l){return l.type==="edit";}).length };
    var filtered = tab===0?logs : tab===1?logs.filter(function(l){return l.type==="delete";}):logs.filter(function(l){return l.type==="edit";});

    var doClear = useCallback(function(){ if(_storage)_storage.logs=[]; forceUpdate(); },[]);
    var doCopy  = useCallback(function(entry){
        var text = entry.type==="edit" ? "[BEFORE] "+entry.content+"\n[AFTER]  "+entry.editedContent : entry.content;
        try { vendetta.metro.common.clipboard.setString(text); } catch(_){}
        try { vendetta.ui.toasts.showToast("Copied!"); } catch(_){}
    },[]);

    // Tab bar
    var tabBar = h(RN.View,{style:{flexDirection:"row",marginHorizontal:12,marginTop:12,marginBottom:8,backgroundColor:C.bgDeep,borderRadius:10,padding:3}},
        [["All",counts.all,"#5865f2"],["Deleted",counts.del,C.delete_],["Edited",counts.edit,C.edit_]].map(function(pair,i){
            var label=pair[0],count=pair[1],accent=pair[2];
            var active=tab===i;
            return h(RN.TouchableOpacity,{key:i,onPress:function(){setTab(i);},activeOpacity:0.8,style:{flex:1,alignItems:"center",paddingVertical:9,borderRadius:8,backgroundColor:active?accent+"33":"transparent",borderWidth:active&&i!==0?1:0,borderColor:active?accent+"66":"transparent"}},
                h(RN.Text,{style:{color:active?(i===2?C.editDark:"#fff"):C.muted,fontWeight:active?"700":"500",fontSize:13}},label),
                h(RN.View,{style:{marginTop:2,backgroundColor:active?"#ffffff22":C.bgPrimary,borderRadius:10,paddingHorizontal:7,paddingVertical:1}},
                    h(RN.Text,{style:{color:active?(i===2?C.editDark:"#fff"):C.muted,fontSize:11,fontWeight:"600"}},String(count))
                )
            );
        })
    );

    var clearBtn = logs.length>0&&h(RN.TouchableOpacity,{onPress:doClear,activeOpacity:0.75,style:{marginHorizontal:12,marginBottom:10,backgroundColor:C.delete_+"18",borderRadius:8,paddingVertical:9,alignItems:"center",borderWidth:1,borderColor:C.delete_+"44"}},
        h(RN.Text,{style:{color:C.delete_,fontWeight:"600",fontSize:13}},"Clear "+filtered.length+" log"+(filtered.length!==1?"s":""))
    );

    var emptyView = h(RN.View,{style:{alignItems:"center",paddingTop:80}},
        h(RN.Text,{style:{fontSize:38,marginBottom:12}},tab===1?"🗑️":tab===2?"✏️":"👁️"),
        h(RN.Text,{style:{color:C.muted,fontSize:16,fontWeight:"600"}},"Nothing logged yet"),
        h(RN.Text,{style:{color:C.muted,fontSize:13,marginTop:6,textAlign:"center",paddingHorizontal:30}},
            tab===1?"Deleted messages will appear here."
            :tab===2?"Edited messages will appear here."
            :"Send some messages first so they get cached.")
    );

    function renderEntry(entry,idx){
        var isDel=entry.type==="delete";
        var accent=isDel?C.delete_:C.edit_;
        var tag=isDel?(entry.bulk?"BULK DEL":"DELETED"):"EDITED";
        return h(RN.TouchableOpacity,{key:entry.msgId+"_"+idx,onLongPress:function(){doCopy(entry);},activeOpacity:0.85,style:{backgroundColor:C.bg,borderRadius:10,marginBottom:8,overflow:"hidden"}},
            h(RN.View,{style:{height:3,backgroundColor:accent}}),
            h(RN.View,{style:{padding:12}},
                h(RN.View,{style:{flexDirection:"row",alignItems:"center",marginBottom:8}},
                    h(RN.View,{style:{backgroundColor:accent+"25",borderRadius:5,paddingHorizontal:7,paddingVertical:3,marginRight:8,borderWidth:1,borderColor:accent+"55"}},
                        h(RN.Text,{style:{color:accent,fontSize:10,fontWeight:"800",letterSpacing:0.8}},tag)
                    ),
                    h(RN.Text,{style:{color:C.text,fontSize:14,fontWeight:"700",flex:1},numberOfLines:1},entry.authorName||"Unknown"),
                    h(RN.View,{style:{alignItems:"flex-end"}},
                        h(RN.Text,{style:{color:C.muted,fontSize:11}},fmtTime(entry.time)),
                        h(RN.Text,{style:{color:C.muted,fontSize:10}},fmtRelative(entry.time))
                    )
                ),
                h(RN.Text,{style:{color:C.muted,fontSize:11,marginBottom:10,fontFamily:"monospace"}},"#"+(entry.channelId||"?")+(entry.guildId?"  •  "+entry.guildId:"  •  DM")),
                isDel
                    ?h(RN.View,{style:{backgroundColor:C.bgDeep,borderRadius:8,padding:10,borderLeftWidth:2,borderLeftColor:C.delete_+"88"}},
                        h(RN.Text,{style:{color:C.text,fontSize:14,lineHeight:20}},entry.content||"(empty)")
                    )
                    :h(RN.View,null,
                        h(RN.View,{style:{backgroundColor:C.bgDeep,borderRadius:8,padding:10,marginBottom:6,borderLeftWidth:2,borderLeftColor:C.delete_+"88"}},
                            h(RN.Text,{style:{color:C.delete_,fontSize:10,fontWeight:"700",marginBottom:4,letterSpacing:0.6}},"BEFORE"),
                            h(RN.Text,{style:{color:C.text,fontSize:14,lineHeight:20}},entry.content||"(empty)")
                        ),
                        h(RN.View,{style:{backgroundColor:C.bgDeep,borderRadius:8,padding:10,borderLeftWidth:2,borderLeftColor:C.edit_+"88"}},
                            h(RN.Text,{style:{color:C.editDark,fontSize:10,fontWeight:"700",marginBottom:4,letterSpacing:0.6}},"AFTER"),
                            h(RN.Text,{style:{color:C.text,fontSize:14,lineHeight:20}},entry.editedContent||"(empty)")
                        )
                    ),
                h(RN.Text,{style:{color:C.muted,fontSize:10,marginTop:8,textAlign:"right"}},"long press to copy")
            )
        );
    }

    return h(RN.View,{style:{flex:1,backgroundColor:C.bgPrimary}},
        tabBar, clearBtn,
        h(RN.ScrollView,{style:{flex:1,paddingHorizontal:12},contentContainerStyle:{paddingBottom:24},showsVerticalScrollIndicator:false},
            filtered.length===0 ? emptyView : filtered.map(renderEntry)
        )
    );
}

// ── Entry ──────────────────────────────────────────────────────────────────

module.exports = {
    onLoad: function() {
        _storage = vendetta.storage.wrapSync(
            vendetta.storage.createStorage(vendetta.storage.createMMKVBackend("msg-logger-store"))
        );
        if (!Array.isArray(_storage.logs)) _storage.logs = [];

        var FluxDispatcher = vendetta.metro.common.FluxDispatcher;
        FluxDispatcher.subscribe("MESSAGE_CREATE",  onFlux);
        FluxDispatcher.subscribe("MESSAGE_UPDATE",  onFlux);
        FluxDispatcher.subscribe("MESSAGE_DELETE",  onFlux);
        FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", onFlux);

        _unpatch = function() {
            FluxDispatcher.unsubscribe("MESSAGE_CREATE",  onFlux);
            FluxDispatcher.unsubscribe("MESSAGE_UPDATE",  onFlux);
            FluxDispatcher.unsubscribe("MESSAGE_DELETE",  onFlux);
            FluxDispatcher.unsubscribe("MESSAGE_DELETE_BULK", onFlux);
        };
    },

    onUnload: function() {
        if (_unpatch) { _unpatch(); _unpatch = null; }
        msgCache  = Object.create(null);
        cacheKeys = [];
        _storage  = null;
    },

    settings: SettingsComponent,
};
