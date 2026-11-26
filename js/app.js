// ============================================================
// AI Chat - 智能对话 App v2.0 (重构版)
// 完整独立版 - 基于免费API
// ============================================================

(function () {
    'use strict';

    // ========== 配置 ==========
    const API_URL = 'https://free-api.cnmwx.com/v1/completions';
    const REQUEST_TIMEOUT = 45000;
    const SUMMARY_TIMEOUT = 150000;
    const API_MAX_BYTES = 262144; // 接口请求体硬上限 256KB
    const MAX_PROMPT_CHARS = 80000; // 中文按 3 字节/字折算，留出 JSON 转义余量
    const SUMMARY_CHUNK_CHARS = 18000; // 单次总结的分块大小
    const STORAGE_KEY = 'aichat_v2';           // 旧版键（仅用于迁移）
    const META_KEY = 'aichat_meta_v3';         // 设置/档案/当前对话
    const CONV_DB = 'aichat_data';             // 对话与图片都放 IndexedDB
    const CONV_STORE = 'conversations';
    const DOM_CLEANUP_THRESHOLD = 200; // 消息数量阈值，超过后清理旧DOM
    const RAF_THROTTLE_MS = 32; // ~30fps 流式渲染节流

    // ========== 增强广告过滤规则 ==========
    const AD_FILTERS = [
        // 原有规则
        /欢迎使用\s*公益站!\s*站长合作邮箱：wxgpt@qq\.com/gi,
        /<br\s*\/?>/gi,
        /公益站.*?站长合作邮箱/gi,
        /https?:\/\/wxgpt\.qq\.com/gi,
        /请勿用于.*?违规用途/gi,
        /本站不承担.*?责任/gi,
        // 新增规则
        /免费使用.*?(?:推广|推荐|注册|下载)/gi,
        /公益.*?(?:站|平台|服务)/gi,
        /https?:\/\/[a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]{10,}/gi,
        /<(?:a|div|span|p|b|i|font|img|iframe)[^>]*>[\s\S]*?<\/\1>/gi,
        /<(?:br|hr)\s*\/?>/gi,
        // 上游没有有效回答时的兜底文案
        /【系统提示：暂无有效回答】/g,
    ];

    // ========== 状态 ==========
    let conversations = {};
    let activeConvId = null;
    let isGenerating = false;
    let abortController = null;
    let searchQuery = '';

    let userProfile = { avatar: '' };
    let aiProfile = { avatar: '' };

    let settings = {
        maxPromptLength: 80000,
        warnThreshold: 56000,
        recentRounds: 10,
        autoCompact: true,
        systemPrompt: '',
        bubbleStyle: 'modern',
        backgroundImage: 'https://t.alcy.cc/ycy',
        backgroundBlur: 0,
        backgroundOpacity: 0.75,
        // 多供应商
        chatProviderId: 'free',
        providers: [],
        imageProviderId: 'gitee',
        imageProviders: [],
        selfPortrait: '',
        // Waifu 模式
        waifuMode: false,
        waifuMergeDelay: 1600,
        colorScheme: 'auto',
        showTimestamp: false,
    };

    // 智能滚动状态
    let userScrolledUp = false;
    let isNearBottom = true;

    // 消息搜索状态
    let msgSearchMatches = [];
    let msgSearchIndex = -1;

    // 右键菜单目标
    let contextMenuTarget = null;

    // 流式渲染 RAF 节流
    let rafPending = false;
    let lastRenderTime = 0;

    // 网络状态
    let isOnline = navigator.onLine;

    // ========== DOM 引用 ==========
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    let converter = null;

    const sidebar = $('#sidebar');
    const sidebarOverlay = $('#sidebar-overlay');
    const chatList = $('#chat-list');
    const chatSearch = $('#chat-search');
    const messagesContainer = $('#messages');
    const welcomeScreen = $('#welcome-screen');
    const welcomeGreeting = $('#welcome-greeting');
    const welcomeTime = $('#welcome-time');
    const chatTitle = $('#chat-title');
    const chatInput = $('#chat-input');
    const sendBtn = $('#send-btn');
    const stopBtn = $('#stop-btn');
    const charCount = $('#char-count');
    const settingsOverlay = $('#settings-overlay');
    const settingsPanel = $('#settings-panel');
    const renameOverlay = $('#rename-overlay');
    const renamePanel = $('#rename-panel');
    const renameInput = $('#rename-input');
    const inputWrapper = $('#input-wrapper');

    // 新增 DOM 引用
    const networkStatus = $('#network-status');
    const contextMenu = $('#context-menu');
    const editOverlay = $('#edit-overlay');
    const editPanel = $('#edit-panel');
    const editInput = $('#edit-input');
    const scrollBottomBtn = $('#scroll-bottom-btn');
    const msgSearchBar = $('#msg-search-bar');
    const msgSearchInput = $('#msg-search-input');
    const msgSearchCount = $('#msg-search-count');
    const statsConvCount = $('#stats-conv-count');
    const statsMsgCount = $('#stats-msg-count');

    // ========== 工具函数 ==========
    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    // 增强广告过滤
    const filterAd = (text) => {
        let cleaned = text;
        for (const regex of AD_FILTERS) {
            cleaned = cleaned.replace(regex, '');
        }
        // 过滤过多空行（3个以上连续换行压缩为2个）
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        return cleaned.trim();
    };

    // 修复：中文欢迎语
    const getTimeGreeting = () => {
        const h = new Date().getHours();
        if (h >= 5 && h < 12) return '\u2600\ufe0f 早上好';
        if (h >= 12 && h < 14) return '\ud83c\udf24\ufe0f 中午好';
        if (h >= 14 && h < 18) return '\ud83c\udf3b 下午好';
        if (h >= 18 && h < 22) return '\ud83c\udf19 晚上好';
        return '\u2728 夜深了';
    };

    function getTimeString() {
        const now = new Date();
        const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
        const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false });
        const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
        return `${dateStr} ${timeStr} ${weekday}`;
    }

    function formatTime(date) {
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    function estimateTokens(text) {
        const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
        const other = text.length - cjk;
        return Math.round(cjk / 1.5 + other / 4);
    }

    // ========== Toast 通知 ==========
    function showToast(message, type = 'info', duration = 2500) {
        const container = $('#toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('toast-out');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // ========== 存储 ==========
    // 对话存 IndexedDB（不受 localStorage 5MB 限制），设置与当前会话存 localStorage。
    // 绝不因为"空间不足"删除用户的对话。
    let _convDb = null;
    let _convSaveTimer = null;
    let _convDirty = false;

    function convDb() {
        if (_convDb) return Promise.resolve(_convDb);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(CONV_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(CONV_STORE)) db.createObjectStore(CONV_STORE, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(IMG_STORE)) db.createObjectStore(IMG_STORE, { keyPath: 'id' });
            };
            req.onsuccess = () => { _convDb = req.result; resolve(_convDb); };
            req.onerror = () => reject(req.error);
        });
    }

    function convTx(mode, fn) {
        return convDb().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(CONV_STORE, mode);
            const r = fn(tx.objectStore(CONV_STORE));
            tx.oncomplete = () => resolve(r && ('result' in r) ? r.result : undefined);
            tx.onerror = () => reject(tx.error);
        }));
    }

    const convAll = () => convTx('readonly', st => st.getAll());
    const convPut = (c) => convTx('readwrite', st => st.put(c));
    const convDel = (id) => convTx('readwrite', st => st.delete(id));

    function saveMeta() {
        const meta = { settings, userProfile, aiProfile, activeConvId, savedAt: Date.now() };
        try {
            localStorage.setItem(META_KEY, JSON.stringify(meta));
        } catch (e) {
            console.error('保存设置失败', e);
            showToast('设置保存失败：浏览器存储空间不足', 'error', 4000);
        }
    }

    async function flushConversations() {
        if (!_convDirty) return;
        _convDirty = false;
        try {
            const db = await convDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(CONV_STORE, 'readwrite');
                const st = tx.objectStore(CONV_STORE);
                st.clear();
                Object.values(conversations).forEach(c => { if (c && c.id) st.put(c); });
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('保存对话失败', e);
            showToast('对话保存失败，请及时导出备份', 'error', 4000);
        }
    }

    function saveAll() {
        saveMeta();
        _convDirty = true;
        clearTimeout(_convSaveTimer);
        _convSaveTimer = setTimeout(flushConversations, 250);
    }

    function saveConversationNow() {
        _convDirty = true;
        clearTimeout(_convSaveTimer);
        return flushConversations();
    }

    async function loadAll() {
        // ---- 1. 读取设置与当前会话 ----
        let hasMeta = false;
        try {
            const raw = localStorage.getItem(META_KEY);
            if (raw) {
                const d = JSON.parse(raw);
                hasMeta = true;
                if (d.settings && typeof d.settings === 'object') settings = { ...settings, ...d.settings };
                if (d.userProfile && typeof d.userProfile === 'object') userProfile = { ...userProfile, ...d.userProfile };
                if (d.aiProfile && typeof d.aiProfile === 'object') aiProfile = { ...aiProfile, ...d.aiProfile };
                activeConvId = d.activeConvId || null;
            }
        } catch (e) { console.error('读取设置失败', e); }

        // ---- 2. 从旧版 localStorage 迁移（只做一次） ----
        try {
            const oldRaw = localStorage.getItem(STORAGE_KEY);
            if (oldRaw) {
                const od = JSON.parse(oldRaw);
                if (!hasMeta) {
                    if (od.settings) settings = { ...settings, ...od.settings };
                    if (od.userProfile) userProfile = { ...userProfile, ...od.userProfile };
                    if (od.aiProfile) aiProfile = { ...aiProfile, ...od.aiProfile };
                    if (od.activeConvId) activeConvId = od.activeConvId;
                }
                if (od.conversations && typeof od.conversations === 'object') {
                    for (const id of Object.keys(od.conversations)) {
                        const c = od.conversations[id];
                        if (c && c.id && Array.isArray(c.messages)) await convPut(c);
                    }
                }
                localStorage.removeItem(STORAGE_KEY);
            }
        } catch (e) { console.error('迁移旧数据失败', e); }

        // ---- 3. 读取对话列表 ----
        conversations = {};
        try {
            const all = await convAll();
            all.forEach(c => {
                if (!c || !c.id) return;
                if (!Array.isArray(c.messages)) c.messages = [];
                if (typeof c.title !== 'string' || !c.title) c.title = '未命名对话';
                if (c.summary === undefined) c.summary = '';
                conversations[c.id] = c;
            });
        } catch (e) {
            console.error('读取对话失败', e);
            showToast('对话数据读取失败，可能是浏览器禁用了本地存储', 'error', 4000);
        }

        // ---- 4. 校验当前会话 ----
        if (!activeConvId || !conversations[activeConvId]) {
            const keys = Object.keys(conversations).sort((a, b) =>
                (conversations[b].updatedAt || 0) - (conversations[a].updatedAt || 0));
            activeConvId = keys.length ? keys[0] : null;
        }
    }

    // 图片压缩：避免把几 MB 的 base64 塞进设置里
    function compressImage(file, maxSide = 1400, quality = 0.82) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                try {
                    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                    const cvs = document.createElement('canvas');
                    cvs.width = Math.max(1, Math.round(img.width * scale));
                    cvs.height = Math.max(1, Math.round(img.height * scale));
                    cvs.getContext('2d').drawImage(img, 0, 0, cvs.width, cvs.height);
                    URL.revokeObjectURL(url);
                    resolve(cvs.toDataURL('image/jpeg', quality));
                } catch (e) { URL.revokeObjectURL(url); reject(e); }
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
            img.src = url;
        });
    }

    // ========== 当前对话 ==========
    function currentConv() {
        return activeConvId && conversations[activeConvId] ? conversations[activeConvId] : null;
    }

    function getMessages() {
        const conv = currentConv();
        return conv ? conv.messages : [];
    }

    function getSummary() {
        const conv = currentConv();
        return conv ? conv.summary || '' : '';
    }

    // ========== 对话统计 ==========
    function updateStats() {
        const convCount = Object.keys(conversations).length;
        let msgCount = 0;
        for (const id of Object.keys(conversations)) {
            msgCount += conversations[id].messages.length;
        }
        if (statsConvCount) statsConvCount.textContent = `${convCount} 个对话`;
        if (statsMsgCount) statsMsgCount.textContent = `${msgCount} 条消息`;
    }

    // ========== 供应商（聊天 / 生图，可多套并存） ==========
    const DEFAULT_PROVIDERS = [
        { id: 'free', name: '公益接口（默认）', type: 'free', baseUrl: 'https://free-api.cnmwx.com/v1/completions', apiKey: '', model: '', maxChars: 80000, warnPercent: 70 }
    ];
    const DEFAULT_IMAGE_PROVIDERS = [
        { id: 'gitee', name: 'Gitee AI（默认）', baseUrl: 'https://ai.gitee.com/v1', apiKey: '', model: 'z-image-turbo', size: '1024x1024' }
    ];

    function ensureProviders() {
        if (!Array.isArray(settings.providers) || settings.providers.length === 0) {
            settings.providers = JSON.parse(JSON.stringify(DEFAULT_PROVIDERS));
        }
        if (!Array.isArray(settings.imageProviders) || settings.imageProviders.length === 0) {
            settings.imageProviders = JSON.parse(JSON.stringify(DEFAULT_IMAGE_PROVIDERS));
        }
        if (!settings.providers.some(x => x.id === settings.chatProviderId)) settings.chatProviderId = settings.providers[0].id;
        if (!settings.imageProviders.some(x => x.id === settings.imageProviderId)) settings.imageProviderId = settings.imageProviders[0].id;
    }

    function currentProvider() {
        ensureProviders();
        return settings.providers.find(x => x.id === settings.chatProviderId) || settings.providers[0];
    }

    // 上下文档位跟着当前聊天接口走：免费接口受 256KB 请求体限制，自定义接口用各自配置
    function providerMaxChars() {
        const p = currentProvider();
        if (p.type === 'free') return 80000;
        const n = parseInt(p.maxChars, 10);
        return (n && n >= 4000) ? n : 128000;
    }

    function providerWarnPercent() {
        const p = currentProvider();
        const n = parseInt(p.warnPercent, 10);
        return (n && n >= 30 && n <= 95) ? n : 70;
    }

    function providerWarnChars() {
        return Math.round(providerMaxChars() * providerWarnPercent() / 100);
    }

    function currentImageProvider() {
        ensureProviders();
        return settings.imageProviders.find(x => x.id === settings.imageProviderId) || settings.imageProviders[0] || null;
    }

    // ========== 图片存储（IndexedDB，避免撑爆 localStorage） ==========
    const IMG_DB = CONV_DB;      // 与对话共用同一个 IndexedDB
    const IMG_STORE = 'images';

    function imgDb() { return convDb(); }

    function idbDo(mode, fn) {
        return imgDb().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(IMG_STORE, mode);
            const r = fn(tx.objectStore(IMG_STORE));
            tx.oncomplete = () => resolve(r && ('result' in r) ? r.result : undefined);
            tx.onerror = () => reject(tx.error);
        }));
    }

    const imgPut = (rec) => idbDo('readwrite', st => st.put(rec));
    const imgGet = (id) => idbDo('readonly', st => st.get(id));
    const imgDel = (id) => idbDo('readwrite', st => st.delete(id));
    const imgAll = () => idbDo('readonly', st => st.getAll());
    const imgClearAll = () => idbDo('readwrite', st => st.clear());

    // ========== 时间与协议块 ==========
    const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const waifu = { timer: null, remainder: '', interrupted: false, playing: false };

    function nowBlock() {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `【现在】${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} ${hh}:${mm}（UTC+8）
这是本轮对话的真实时间。凡是涉及"今天、昨天、明天、刚才、上周、多久没聊、现在几点"这类相对时间，一律以它为唯一基准；不要用你训练数据里的日期，也不要反问用户今天几号。`;
    }

    const WAIFU_PROTOCOL = `【聊天方式：像真人一样发消息】
你在用手机和对方聊天。一条回复可以拆成几条短消息依次发出，用 ||| 分隔（三个竖线）。
- 大多数时候 1~2 条就够；只有情绪激动、连珠炮、想到什么补一句、或者要制造停顿感时，才拆成 3 条甚至更多。
- 每条都口语化、简短，像随手打的字；不要写长段落，不要列点，不要编号，不要在开头复述对方的话。
- 绝对不要用 ||| 做别的用途（不要用它分隔句子成分，不要写在代码里）。
- 不要把格式规则说给用户听。`;

    function imageProtocol() {
        const portrait = (settings.selfPortrait || '').trim();
        const base = `【生图能力】你可以生成图片。当用户想看照片、要自拍、要你"现在拍一张"、或者任何需要图像回应的场景，在文字之后另起一行输出：
<genimg prompt="英文画面描述" />
规则：
- prompt 必须用英文，写清外貌、服装、表情、动作、环境、光线、镜头与风格（如 photorealistic, selfie, natural light, 35mm）。
- 一次回复最多一个 <genimg>；如果只是想聊天，就不要调用。
- 不要在正文里解释或提及这个标签，它会自动变成图片。`;
        if (portrait) return base + `\n- 当画面里出现"你"本人时，外貌必须符合这个固定设定：${portrait}`;
        return base + `\n- 当画面里出现"你"本人时，外貌请参考你在系统设定里的人设，保持前后一致。`;
    }

    function interruptBlock() {
        if (!settings.waifuMode || !waifu.remainder) return '';
        return `【刚才被打断】你上一条回复还没说完，就被对方的新消息打断了。你原本准备继续说的是：「${waifu.remainder.slice(0, 600)}」
请自然地处理这次打断：可以接着往下说、可以改口、也可以先回应对方的新消息。不要机械复述被打断的内容，不要向用户解释"我被中断了"，也不要提"系统"或"协议"。`;
    }

    // ========== 构建上下文 ==========
    function activeSystemPrompt(conv) {
        const c = conv || currentConv();
        const own = c && c.systemPrompt ? String(c.systemPrompt).trim() : '';
        return own || (settings.systemPrompt || '').trim();
    }

    function msgText(m) {
        if (!m) return '';
        if (m.type === 'image') return `[图片：${m.prompt || '已生成的图片'}]`;
        return m.content || '';
    }

    // 系统设定 → 现在 → 历史摘要 → waifu 协议 → 生图协议 → 打断说明
    function headBlocks() {
        const parts = [];
        const sys = activeSystemPrompt();
        if (sys) parts.push(`【系统设定】\n${sys}\n【系统设定结束】`);
        parts.push(nowBlock());
        const summary = getSummary();
        if (summary.trim()) parts.push(`【历史摘要】\n${summary.trim()}\n【摘要结束】`);
        if (settings.waifuMode) parts.push(WAIFU_PROTOCOL);
        if (currentImageProvider()) parts.push(imageProtocol());
        const ib = interruptBlock();
        if (ib) parts.push(ib);
        return parts.join('\n\n');
    }

    // 历史消息：排除本轮（已 push 的那条），只取最近 N 轮
    function historyMsgs(userMsg) {
        let msgs = getMessages().slice();
        if (userMsg && msgs.length > 0 && msgs[msgs.length - 1].role === 'user') msgs = msgs.slice(0, -1);
        return msgs.slice(-settings.recentRounds * 2);
    }

    function buildPrompt(userMsg) {
        const parts = [headBlocks()];
        for (const m of historyMsgs(userMsg)) {
            parts.push((m.role === 'user' ? 'Human: ' : 'AI: ') + msgText(m));
        }
        if (userMsg) {
            parts.push(`Human: ${userMsg}`);
            parts.push(`AI:`);
        }
        return parts.join('\n');
    }

    // OpenAI 兼容接口用 messages 结构
    function buildMessages(userMsg) {
        const arr = [{ role: 'system', content: headBlocks() }];
        for (const m of historyMsgs(userMsg)) {
            arr.push({ role: m.role === 'user' ? 'user' : 'assistant', content: msgText(m) });
        }
        if (userMsg) arr.push({ role: 'user', content: userMsg });
        return arr;
    }

    // ========== 统一调用层 ==========
    async function callChat(opts) {
        const { promptText, messages, onDelta, signal } = opts;
        const p = currentProvider();

        if (p.type === 'openai') {
            const url = p.baseUrl.replace(/\/+$/, '') + '/chat/completions';
            const headers = { 'Content-Type': 'application/json' };
            if (p.apiKey) headers['Authorization'] = 'Bearer ' + p.apiKey;
            const resp = await fetch(url, {
                method: 'POST', headers, signal,
                body: JSON.stringify({ model: p.model || 'gpt-3.5-turbo', messages, stream: true }),
            });
            if (!resp.ok) {
                const t = await resp.text().catch(() => '');
                throw new Error(`HTTP ${resp.status} ${t.slice(0, 120)}`);
            }
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                const j = await resp.json();
                const c0 = j.choices && j.choices[0];
                const txt = c0 && (c0.message ? c0.message.content : c0.text);
                if (txt) onDelta(txt);
                return;
            }
            const reader = resp.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, idx).trim();
                    buf = buf.slice(idx + 1);
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (data === '[DONE]') return;
                    try {
                        const j = JSON.parse(data);
                        const c0 = j.choices && j.choices[0];
                        const d = c0 && c0.delta ? c0.delta.content : null;
                        if (d) onDelta(d);
                    } catch (e) { /* 分片不完整，忽略 */ }
                }
            }
            return;
        }

        const resp = await fetch(p.baseUrl || API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: promptText }),
            signal,
        });
        if (!resp.ok) {
            const t = await resp.text().catch(() => '');
            throw new Error(`HTTP ${resp.status} ${t.slice(0, 120)}`);
        }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            onDelta(dec.decode(value, { stream: true }));
        }
    }

    // ========== 生图 ==========
    async function requestImage(promptText) {
        const p = currentImageProvider();
        if (!p) throw new Error('还没有配置生图服务');
        const url = p.baseUrl.replace(/\/+$/, '') + '/images/generations';
        const headers = { 'Content-Type': 'application/json' };
        if (p.apiKey) headers['Authorization'] = 'Bearer ' + p.apiKey;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 180000);
        try {
            const resp = await fetch(url, {
                method: 'POST', headers, signal: ctrl.signal,
                body: JSON.stringify({
                    model: p.model || 'z-image-turbo',
                    prompt: promptText,
                    size: p.size || '1024x1024',
                    n: 1,
                    response_format: 'b64_json',
                }),
            });
            if (!resp.ok) {
                const t = await resp.text().catch(() => '');
                throw new Error(`生图失败 HTTP ${resp.status} ${t.slice(0, 120)}`);
            }
            const j = await resp.json();
            const item = j.data && j.data[0];
            if (!item) throw new Error('生图返回为空');
            if (item.b64_json) return 'data:image/png;base64,' + item.b64_json;
            if (item.url) return item.url;
            throw new Error('生图返回格式不支持');
        } finally {
            clearTimeout(timer);
        }
    }

    // 兜底：压缩后仍超长时保留头尾、省略中段，避免撞 256KB
    function fitPrompt(prompt) {
        const cap = Math.min(providerMaxChars(), Math.floor(API_MAX_BYTES / 3) - 200);
        if (prompt.length <= cap) return prompt;
        const headLen = Math.floor(cap * 0.34);
        const tailLen = cap - headLen - 40;
        return prompt.slice(0, headLen)
            + '\n...[中间内容过长，已省略]...\n'
            + prompt.slice(-tailLen);
    }

    // UTF-8 字节数：接口 256KB 限制卡的是字节，不是字符
    function utf8Bytes(str) {
        try { return new TextEncoder().encode(str).length; }
        catch (e) { return str.length * 3; }
    }

    // ========== Markdown 渲染 ==========
    function renderMarkdown(text) {
        if (!converter) return escapeHTML(text);
        let html = converter.makeHtml(text);
        // 代码块包装 + 复制按钮
        html = html.replace(/<pre><code([^>]*)>/g, (match, attrs) => {
            return `<div class="code-block-wrapper"><button class="code-copy-btn" onclick="window.__copyCode(this)" title="复制代码">\u{1f4cb}</button><pre><code${attrs}>`;
        });
        html = html.replace(/<\/code><\/pre>/g, '</code></pre></div>');
        return html;
    }

    window.__copyCode = function (btn) {
        const code = btn.parentElement.querySelector('code');
        if (code) {
            navigator.clipboard.writeText(code.textContent).then(() => {
                btn.textContent = '\u2705';
                setTimeout(() => btn.textContent = '\u{1f4cb}', 1500);
            }).catch(() => {
                showToast('复制失败', 'error');
            });
        }
    };

    // ========== 头像 HTML ==========
    function getAvatarHTML(profile, role, size = 36) {
        if (profile.avatar && profile.avatar.trim()) {
            return `<div class="avatar"><img src="${escapeAttr(profile.avatar)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
            <div class="avatar-default avatar-${role}" style="display:none;">${role === 'user' ? '\ud83d\ude0a' : '\ud83e\udd16'}</div></div>`;
        }
        const emoji = role === 'user' ? '\ud83d\ude0a' : '\ud83e\udd16';
        return `<div class="avatar"><div class="avatar-default avatar-${role}">${emoji}</div></div>`;
    }

    // ========== HTML 转义 ==========
    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ========== 智能滚动 ==========
    function checkNearBottom() {
        const el = messagesContainer;
        const threshold = 100;
        isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
        return isNearBottom;
    }

    function scrollToBottom(force = false) {
        if (force || isNearBottom) {
            requestAnimationFrame(() => {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            });
        }
    }

    function updateScrollButton() {
        if (!scrollBottomBtn) return;
        const near = checkNearBottom();
        if (near) {
            scrollBottomBtn.classList.remove('visible');
            userScrolledUp = false;
        } else {
            scrollBottomBtn.classList.add('visible');
            userScrolledUp = true;
        }
    }

    // ========== 渲染消息 ==========
    function renderMessage(msg, animate = true, skipScroll = false) {
        hideWelcome();

        const row = document.createElement('div');
        row.className = `msg-row ${msg.role}`;
        if (!animate) row.classList.add('no-anim');
        row.dataset.msgId = msg.id || '';

        const profile = msg.role === 'user' ? userProfile : aiProfile;
        row.innerHTML = getAvatarHTML(profile, msg.role);

        const col = document.createElement('div');
        col.className = 'bubble-col';

        const bubble = document.createElement('div');
        bubble.className = `bubble ${settings.bubbleStyle} ${msg.role}`;
        const contentDiv = document.createElement('div');
        contentDiv.className = 'bubble-content';

        if (msg.type === 'image') {
            if (msg.imageInline) {
                const img = document.createElement('img');
                img.className = 'msg-image';
                img.src = msg.imageInline;
                img.alt = msg.prompt || '生成的图片';
                img.addEventListener('click', () => openImageViewer(msg.imageInline));
                contentDiv.appendChild(img);
            } else {
            contentDiv.innerHTML = '<div class="image-loading"><span class="dot-pulse"></span>加载图片…</div>';
            imgGet(msg.imageId).then(rec => {
                if (rec && rec.data) {
                    contentDiv.innerHTML = '';
                    const img = document.createElement('img');
                    img.className = 'msg-image';
                    img.src = rec.data;
                    img.alt = msg.prompt || '生成的图片';
                    img.dataset.imgId = msg.imageId;
                    img.addEventListener('click', () => openImageViewer(rec.data));
                    contentDiv.appendChild(img);
                } else {
                    contentDiv.textContent = '[图片已删除]';
                }
            }).catch(() => { contentDiv.textContent = '[图片读取失败]'; });
            }
        } else if (msg.role === 'user') {
            contentDiv.textContent = msg.content;
        } else {
            contentDiv.innerHTML = renderMarkdown(msg.content);
            highlightCode(contentDiv);
        }
        bubble.appendChild(contentDiv);

        // 复制按钮
        if (msg.type !== 'image') {
            const copyBtn = document.createElement('button');
            copyBtn.className = 'bubble-copy';
            copyBtn.innerHTML = '\u{1f4cb}';
            copyBtn.title = '复制';
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const txt = msg.content || '';
                navigator.clipboard.writeText(filterAd(txt)).then(() => {
                    copyBtn.innerHTML = '\u2705';
                    copyBtn.classList.add('copied');
                    setTimeout(() => { copyBtn.innerHTML = '\u{1f4cb}'; copyBtn.classList.remove('copied'); }, 1500);
                    showToast('已复制到剪贴板', 'success', 1500);
                }).catch(() => showToast('复制失败', 'error'));
            });
            bubble.appendChild(copyBtn);
        }

        col.appendChild(bubble);

        // 时间戳放到气泡下方（不再塞进气泡里）
        if (settings.showTimestamp && msg.timestamp) {
            const meta = document.createElement('div');
            meta.className = 'msg-meta';
            const ts = document.createElement('span');
            ts.className = 'msg-timestamp';
            ts.textContent = formatTime(new Date(msg.timestamp));
            meta.appendChild(ts);
            if (msg.role === 'assistant' && msg.type !== 'image') {
                const tokens = document.createElement('span');
                tokens.className = 'msg-token-count';
                tokens.textContent = `~${estimateTokens(msg.content || '')} tokens`;
                meta.appendChild(tokens);
            }
            col.appendChild(meta);
        }

        row.appendChild(col);

        if (msg.role === 'assistant') {
            const actions = document.createElement('div');
            actions.className = 'bubble-actions';
            const regenBtn = document.createElement('button');
            regenBtn.className = 'bubble-action-btn';
            regenBtn.innerHTML = '\ud83d\udd04';
            regenBtn.title = '重新生成';
            regenBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                regenerateMessage(msg);
            });
            actions.appendChild(regenBtn);
            row.appendChild(actions);
        }

        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, msg, row);
        });

        messagesContainer.appendChild(row);
        if (!skipScroll) scrollToBottom();
    }

    function renderSystemMessage(text, skipScroll = false) {
        hideWelcome();
        const row = document.createElement('div');
        row.style.cssText = 'text-align:center;display:flex;justify-content:center;';
        const el = document.createElement('div');
        el.className = 'msg-system';
        el.textContent = text;
        row.appendChild(el);
        messagesContainer.appendChild(row);
        if (!skipScroll) scrollToBottom();
    }

    function highlightCode(container) {
        if (typeof hljs !== 'undefined') {
            container.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
        }
    }

    function hideWelcome() { if (welcomeScreen) welcomeScreen.style.display = 'none'; }

    function showWelcome() {
        if (welcomeScreen) {
            welcomeScreen.style.display = 'flex';
            welcomeGreeting.textContent = getTimeGreeting();
            welcomeTime.textContent = getTimeString();
        }
    }

    // ========== 内存管理：长对话清理旧DOM ==========
    function cleanupOldDOMNodes() {
        const children = messagesContainer.children;
        const msgRows = messagesContainer.querySelectorAll('.msg-row');
        if (msgRows.length > DOM_CLEANUP_THRESHOLD) {
            const toRemove = msgRows.length - DOM_CLEANUP_THRESHOLD;
            for (let i = 0; i < toRemove; i++) {
                msgRows[i].remove();
            }
        }
    }

    // ========== 流式渲染 RAF 节流 ==========
    function throttledRender(aiContent, text) {
        if (rafPending) return;
        const now = performance.now();
        if (now - lastRenderTime < RAF_THROTTLE_MS) return;
        rafPending = true;
        lastRenderTime = now;
        requestAnimationFrame(() => {
            const cleaned = filterAd(text);
            aiContent.innerHTML = renderMarkdown(cleaned);
            highlightCode(aiContent);
            scrollToBottom();
            rafPending = false;
        });
    }

    // ========== 重新生成 ==========
    async function regenerateMessage(msg) {
        if (isGenerating) return;

        const msgs = getMessages();
        const idx = msgs.indexOf(msg);
        if (idx < 0) return;

        if (idx === 0 || msgs[idx - 1].role !== 'user') {
            showToast('无法重新生成此消息', 'warning');
            return;
        }

        // 移除这条AI消息
        msgs.splice(idx, 1);

        // 重建UI
        rebuildMessagesUI();

        // 获取用户消息
        const userMsg = msgs[idx - 1].content;

        await sendForRegenerate(userMsg);
    }

    async function sendForRegenerate(userMsg) {
        if (isGenerating) return;

        const prompt = fitPrompt(buildPrompt(userMsg));

        // 创建AI气泡 - 修复：aiRow 已有 position:relative
        const aiRow = document.createElement('div');
        aiRow.className = 'msg-row assistant';
        aiRow.innerHTML = getAvatarHTML(aiProfile, 'assistant');

        const aiBubble = document.createElement('div');
        aiBubble.className = `bubble ${settings.bubbleStyle} assistant`;
        const aiContent = document.createElement('div');
        aiContent.className = 'bubble-content';
        aiContent.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
        aiBubble.appendChild(aiContent);
        aiRow.appendChild(aiBubble);
        messagesContainer.appendChild(aiRow);
        scrollToBottom(true);

        isGenerating = true;
        updateInputState();
        abortController = new AbortController();

        const timeoutId = setTimeout(() => { if (abortController) abortController.abort(); }, REQUEST_TIMEOUT);

        try {
            let fullText = '';
            await callChat({
                promptText: prompt,
                messages: buildMessages(userMsg),
                signal: abortController.signal,
                onDelta: (d) => { fullText += d; throttledRender(aiContent, fullText); },
            });
            clearTimeout(timeoutId);

            const { text, prompt: imgPrompt } = extractGenimg(fullText);
            const final = filterAd(text);
            aiContent.innerHTML = final ? renderMarkdown(final) : '<span style="opacity:.6">（已生成图片）</span>';
            highlightCode(aiContent);

            getMessages().push({ role: 'assistant', content: final, timestamp: Date.now(), id: uid() });
            if (imgPrompt) handleGenImage(imgPrompt);

        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                const partial = aiContent.textContent;
                if (partial && partial !== '思考中...') {
                    aiContent.innerHTML += ' <span style="opacity:0.6;font-size:13px;">\u23f1 已停止</span>';
                    getMessages().push({ role: 'assistant', content: filterAd(partial), timestamp: Date.now(), id: uid() });
                } else {
                    aiContent.innerHTML = '\u23f1 请求超时或已停止';
                }
            } else {
                aiContent.innerHTML = `<div style="color:var(--danger);">\u26a0\ufe0f ${escapeHTML(err.message || '网络或服务异常')}</div><div class="msg-error-actions"><button class="msg-retry-btn" onclick="window.__retryRegenerate()">\ud83d\udd04 重试</button></div>`;
                console.error('重新生成失败:', err);
            }
        } finally {
            isGenerating = false;
            updateInputState();
            abortController = null;
            if (currentConv()) currentConv().updatedAt = Date.now();
            saveAll();
            updateContextUsage();
            updateStats();
        }
    }

    // 重试重新生成（挂到全局）
    window.__retryRegenerate = function () {
        const msgs = getMessages();
        // 找到最后一条用户消息重新生成
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') {
                const userMsg = msgs[i].content;
                rebuildMessagesUI();
                sendForRegenerate(userMsg);
                return;
            }
        }
    };

    // ========== 发送消息 ==========
    async function sendMessage(overrideText) {
        const userMsg = (overrideText || chatInput.value).trim();
        if (!userMsg) return;

        // 发送按钮动画
        sendBtn.classList.add('sending');
        setTimeout(() => sendBtn.classList.remove('sending'), 400);

        if (!activeConvId || !conversations[activeConvId]) {
            createConversation(userMsg.slice(0, 30));
        }

        chatInput.value = '';
        autoResizeInput();
        updateCharCount();
        updateSendButtonState();

        const userMsgObj = { role: 'user', content: userMsg, timestamp: Date.now(), id: uid() };
        getMessages().push(userMsgObj);
        renderMessage(userMsgObj, true);

        const conv = currentConv();
        const userCount = getMessages().filter(m => m.role === 'user').length;
        if (conv && !conv.titleLocked && userCount === 1 && (!conv.title || conv.title === '新对话')) {
            conv.title = userMsg.slice(0, 30) + (userMsg.length > 30 ? '...' : '');
            renderChatList();
            updateChatTitle();
        }
        if (conv) conv.updatedAt = Date.now();
        saveAll();
        updateStats();

        // Waifu 模式：消息先进缓冲，等用户停手再统一回复
        if (settings.waifuMode) {
            if (isGenerating && abortController) {
                waifu.interrupted = true;
                abortController.abort();
            }
            scheduleWaifuReply();
            return;
        }

        await runNormalTurn(userMsg);
    }

    // ---------- 普通模式：一问一答，流式 ----------
    async function runNormalTurn(userMsg) {
        if (isGenerating) return;

        let prompt = buildPrompt(userMsg);
        const cap = providerMaxChars();
        const warnAt = providerWarnChars();
        if (settings.autoCompact && prompt.length > cap) {
            renderSystemMessage(`\u26a0\ufe0f 上下文已达 ${prompt.length} 字符，正在自动压缩旧消息...`);
            const ok = await compactConversation({ manual: false, silent: false });
            if (ok) prompt = buildPrompt(userMsg);
        } else if (prompt.length > warnAt) {
            renderSystemMessage(`\u2139\ufe0f 上下文较长（${prompt.length} 字符），可点顶栏压缩按钮整理记忆`);
        }
        prompt = fitPrompt(prompt);

        // 创建AI气泡
        const aiRow = document.createElement('div');
        aiRow.className = 'msg-row assistant';
        aiRow.innerHTML = getAvatarHTML(aiProfile, 'assistant');

        const aiBubble = document.createElement('div');
        aiBubble.className = `bubble ${settings.bubbleStyle} assistant`;
        const aiContent = document.createElement('div');
        aiContent.className = 'bubble-content';
        aiContent.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
        aiBubble.appendChild(aiContent);
        aiRow.appendChild(aiBubble);
        messagesContainer.appendChild(aiRow);
        scrollToBottom(true);

        isGenerating = true;
        updateInputState();
        abortController = new AbortController();

        const timeoutId = setTimeout(() => { if (abortController) abortController.abort(); }, REQUEST_TIMEOUT);

        try {
            let fullText = '';
            await callChat({
                promptText: prompt,
                messages: buildMessages(userMsg),
                signal: abortController.signal,
                onDelta: (d) => { fullText += d; throttledRender(aiContent, fullText); },
            });
            clearTimeout(timeoutId);

            const { text, prompt: imgPrompt } = extractGenimg(fullText);
            const final = filterAd(text);
            aiContent.innerHTML = final ? renderMarkdown(final) : '<span style="opacity:.6">（已生成图片）</span>';
            highlightCode(aiContent);

            getMessages().push({ role: 'assistant', content: final, timestamp: Date.now(), id: uid() });
            if (imgPrompt) handleGenImage(imgPrompt);

        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                const partial = aiContent.textContent;
                if (partial && partial !== '思考中...') {
                    aiContent.innerHTML += ' <span style="opacity:0.6;font-size:13px;">\u23f1 已停止</span>';
                    getMessages().push({ role: 'assistant', content: filterAd(partial), timestamp: Date.now(), id: uid() });
                } else {
                    aiContent.innerHTML = '\u23f1 请求超时或已停止';
                }
            } else {
                aiContent.innerHTML = `<div style="color:var(--danger);">\u26a0\ufe0f ${escapeHTML(err.message || '网络或服务异常')}</div><div class="msg-error-actions"><button class="msg-retry-btn">\ud83d\udd04 重试</button></div>`;
                const retryBtn = aiContent.querySelector('.msg-retry-btn');
                if (retryBtn) {
                    retryBtn.addEventListener('click', () => {
                        const msgs = getMessages();
                        if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') msgs.pop();
                        rebuildMessagesUI();
                        sendMessage(userMsg);
                    });
                }
                console.error('发送消息失败:', err);
            }
        } finally {
            isGenerating = false;
            updateInputState();
            abortController = null;
            if (currentConv()) currentConv().updatedAt = Date.now();
            saveAll();
            updateContextUsage();
            updateStats();
            cleanupOldDOMNodes();
        }
    }

    // ---------- 生图标签解析 ----------
    function extractGenimg(text) {
        const src = String(text || '');
        let m = src.match(/<\s*genimg\b[^>]*?prompt\s*=\s*"([^"]*)"[^>]*?\/?\s*>/i);
        if (!m) m = src.match(/<\s*genimg\b[^>]*?prompt\s*=\s*'([^']*)'[^>]*?\/?\s*>/i);
        if (!m) m = src.match(/<\s*genimg\b[^>]*?prompt\s*=\s*([^"'>]+?)\s*\/?\s*>/i);
        if (!m) return { text: src, prompt: '' };
        return { text: (src.slice(0, m.index) + src.slice(m.index + m[0].length)).trim(), prompt: m[1].trim() };
    }

    // ---------- 生图渲染 ----------
    async function handleGenImage(promptText) {
        const holder = document.createElement('div');
        holder.className = 'msg-row assistant';
        holder.innerHTML = getAvatarHTML(aiProfile, 'assistant');
        const col = document.createElement('div');
        col.className = 'bubble-col';
        const bubble = document.createElement('div');
        bubble.className = `bubble ${settings.bubbleStyle} assistant`;
        const content = document.createElement('div');
        content.className = 'bubble-content';
        content.innerHTML = '<div class="image-loading"><span class="dot-pulse"></span>正在生成图片…</div>';
        bubble.appendChild(content);
        col.appendChild(bubble);
        holder.appendChild(col);
        messagesContainer.appendChild(holder);
        scrollToBottom(true);

        try {
            const src = await requestImage(promptText);
            const imageId = uid();
            let stored = true;
            try {
                await imgPut({ id: imageId, data: src, prompt: promptText, createdAt: Date.now() });
            } catch (e) {
                stored = false;
                console.warn('图片入库失败，改为内联保存', e);
            }
            content.innerHTML = '';
            const img = document.createElement('img');
            img.className = 'msg-image';
            img.src = src;
            img.alt = '生成的图片';
            img.dataset.imgId = imageId;
            img.addEventListener('click', () => openImageViewer(src));
            content.appendChild(img);
            getMessages().push({
                role: 'assistant', type: 'image', imageId, prompt: promptText,
                imageInline: stored ? '' : src,
                timestamp: Date.now(), id: uid(),
            });
            saveAll();
            updateStats();
            scrollToBottom();
        } catch (e) {
            content.innerHTML = `<div style="color:var(--danger);font-size:14px;">\u26a0\ufe0f ${escapeHTML(e.message || '生图失败')}</div>`;
            console.error('生图失败', e);
        }
    }

    function openImageViewer(src) {
        let v = document.getElementById('image-viewer');
        if (!v) {
            v = document.createElement('div');
            v.id = 'image-viewer';
            const img = document.createElement('img');
            v.appendChild(img);
            v.addEventListener('click', () => v.classList.remove('active'));
            document.body.appendChild(v);
        }
        v.querySelector('img').src = src;
        v.classList.add('active');
    }

    // ---------- Waifu 模式 ----------
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    function scheduleWaifuReply() {
        clearTimeout(waifu.timer);
        waifu.timer = setTimeout(() => { waifu.timer = null; runWaifuTurn(); }, settings.waifuMergeDelay || 1600);
    }

    function createBubbleRow() {
        const row = document.createElement('div');
        row.className = 'msg-row assistant';
        row.innerHTML = getAvatarHTML(aiProfile, 'assistant');
        const col = document.createElement('div');
        col.className = 'bubble-col';
        const bubble = document.createElement('div');
        bubble.className = `bubble ${settings.bubbleStyle} assistant`;
        const content = document.createElement('div');
        content.className = 'bubble-content';
        bubble.appendChild(content);
        col.appendChild(bubble);
        row.appendChild(col);
        messagesContainer.appendChild(row);
        return { row, content };
    }

    function splitWaifuMessages(text) {
        const t = String(text || '').replace(/<br\s*\/?>/gi, '\n').trim();
        let parts = t.split(/\s*\|{2,}\s*/).map(x => x.trim()).filter(Boolean);
        if (parts.length <= 1) {
            const seg = t.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
            if (seg.length > 1 && seg.length <= 5) parts = seg;
        }
        if (parts.length > 6) parts = [...parts.slice(0, 5), parts.slice(5).join(' ')];
        return parts.length ? parts : [t];
    }

    async function playWaifuBubbles(fullText) {
        const parts = splitWaifuMessages(filterAd(fullText));
        waifu.playing = true;
        let emitted = 0;

        for (let i = 0; i < parts.length; i++) {
            if (waifu.interrupted) { waifu.remainder = parts.slice(i).join(' '); break; }

            const raw = parts[i];
            const { text, prompt } = extractGenimg(raw);

            const { row, content } = createBubbleRow();
            content.innerHTML = '<div class="typing-bubble"><i></i><i></i><i></i></div>';
            scrollToBottom();

            // 模拟打字：字数越多"正在输入"越久
            await sleep(480 + Math.min(1500, raw.length * 26) + Math.random() * 320);
            if (waifu.interrupted) {
                row.remove();
                waifu.remainder = parts.slice(i).join(' ');
                break;
            }

            const finalText = filterAd(text);
            content.innerHTML = finalText ? renderMarkdown(finalText) : '';
            highlightCode(content);
            if (finalText) {
                getMessages().push({ role: 'assistant', content: finalText, timestamp: Date.now(), id: uid() });
            }
            emitted++;
            scrollToBottom();

            // 生图要等它真的出来再继续下一条，否则图片会插到后面消息的下面
            if (prompt) {
                await handleGenImage(prompt);
                if (waifu.interrupted) {
                    waifu.remainder = parts.slice(i + 1).join(' ');
                    break;
                }
            }

            if (i < parts.length - 1) await sleep(240 + Math.random() * 380);
        }

        waifu.playing = false;
        if (emitted > 0) waifu.remainder = '';
    }

    async function runWaifuTurn() {
        if (!settings.waifuMode) return;
        if (isGenerating) {
            // 上一轮还在收尾，稍后重试，避免"打断后就不再回复"
            scheduleWaifuReply();
            return;
        }
        const conv = currentConv();
        if (!conv) return;
        const msgs = getMessages();
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== 'user') return;

        isGenerating = true;
        waifu.interrupted = false;
        updateInputState();
        abortController = new AbortController();

        const typing = createBubbleRow();
        typing.content.innerHTML = '<div class="typing-bubble"><i></i><i></i><i></i></div>';
        scrollToBottom();

        let fullText = '';
        try {
            await callChat({
                promptText: fitPrompt(buildPrompt(last.content)),
                messages: buildMessages(last.content),
                signal: abortController.signal,
                onDelta: (d) => { fullText += d; },
            });
            typing.row.remove();
            if (!fullText.trim()) {
                renderSystemMessage('\u26a0\ufe0f 这次没有生成内容，可以再发一句试试');
            } else {
                await playWaifuBubbles(fullText);
            }
        } catch (e) {
            typing.row.remove();
            if (e.name === 'AbortError') {
                // 被打断：还没发出去的文字留给下一轮 prompt
                if (!waifu.remainder) waifu.remainder = filterAd(fullText);
            } else {
                console.error('waifu 生成失败', e);
                renderSystemMessage('\u26a0\ufe0f ' + (e.message || '请求失败'));
            }
        } finally {
            isGenerating = false;
            abortController = null;
            updateInputState();
            saveAll();
            updateContextUsage();
            updateStats();
        }
    }

    function stopGeneration() {
        clearTimeout(waifu.timer);
        waifu.timer = null;
        waifu.remainder = '';
        if (abortController) abortController.abort();
    }

    // ========== 输入状态管理 ==========
    function updateInputState() {
        const wf = !!settings.waifuMode;
        // Waifu 模式下生成中也能继续发消息（用于打断并重新并入）
        if (isGenerating && !wf) {
            sendBtn.style.display = 'none';
            stopBtn.style.display = 'flex';
        } else if (isGenerating && wf) {
            // waifu 生成中：发送（打断并发送）和停止同时可用
            sendBtn.style.display = 'flex';
            stopBtn.style.display = 'flex';
        } else {
            sendBtn.style.display = 'flex';
            stopBtn.style.display = 'none';
        }
        updateSendButtonState();
        chatInput.disabled = isGenerating && !wf;
    }

    function updateSendButtonState() {
        const hasContent = chatInput.value.trim().length > 0;
        sendBtn.disabled = !hasContent || (isGenerating && !settings.waifuMode);
    }

    // ========== 消息编辑 ==========
    function showEditDialog(msg) {
        if (isGenerating) return;
        contextMenuTarget = msg;
        editInput.value = msg.content;
        editOverlay.classList.add('active');
        editPanel.classList.add('active');
        setTimeout(() => editInput.focus(), 100);
    }

    function closeEditDialog() {
        editOverlay.classList.remove('active');
        editPanel.classList.remove('active');
        contextMenuTarget = null;
    }

    function confirmEdit() {
        if (!contextMenuTarget) return;
        const newContent = editInput.value.trim();
        if (!newContent) {
            showToast('消息内容不能为空', 'warning');
            return;
        }

        const msgs = getMessages();
        const idx = msgs.indexOf(contextMenuTarget);
        if (idx < 0) {
            closeEditDialog();
            return;
        }

        // 更新消息内容
        contextMenuTarget.content = newContent;
        contextMenuTarget.timestamp = Date.now();

        // 删除该消息之后的所有消息
        msgs.splice(idx + 1);

        closeEditDialog();

        // 重建UI后基于已存在的用户消息重新生成
        // 注意：这里不能再用 sendMessage，否则会再 push 一条相同消息，出现"连发两次"
        rebuildMessagesUI();
        sendForRegenerate(newContent);
    }

    // ========== 消息搜索 ==========
    function toggleMsgSearch(show) {
        if (show) {
            msgSearchBar.classList.add('active');
            msgSearchInput.focus();
            clearMsgSearchHighlights();
        } else {
            msgSearchBar.classList.remove('active');
            msgSearchInput.value = '';
            msgSearchCount.textContent = '';
            clearMsgSearchHighlights();
            msgSearchMatches = [];
            msgSearchIndex = -1;
        }
    }

    function performMsgSearch(query) {
        clearMsgSearchHighlights();
        msgSearchMatches = [];
        msgSearchIndex = -1;

        if (!query.trim()) {
            msgSearchCount.textContent = '';
            return;
        }

        const q = query.toLowerCase();
        const rows = messagesContainer.querySelectorAll('.msg-row');

        rows.forEach(row => {
            const bubble = row.querySelector('.bubble-content');
            if (!bubble) return;
            const text = bubble.textContent.toLowerCase();
            if (text.includes(q)) {
                msgSearchMatches.push(row);
            }
        });

        msgSearchCount.textContent = msgSearchMatches.length > 0
            ? `1/${msgSearchMatches.length}`
            : '无匹配';

        if (msgSearchMatches.length > 0) {
            msgSearchIndex = 0;
            highlightCurrentMatch();
        }
    }

    function navigateMsgSearch(direction) {
        if (msgSearchMatches.length === 0) return;
        // 清除旧高亮
        if (msgSearchMatches[msgSearchIndex]) {
            msgSearchMatches[msgSearchIndex].classList.remove('msg-highlight');
        }
        msgSearchIndex = (msgSearchIndex + direction + msgSearchMatches.length) % msgSearchMatches.length;
        msgSearchCount.textContent = `${msgSearchIndex + 1}/${msgSearchMatches.length}`;
        highlightCurrentMatch();
    }

    function highlightCurrentMatch() {
        const row = msgSearchMatches[msgSearchIndex];
        if (!row) return;
        row.classList.add('msg-highlight');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // 移除高亮动画
        setTimeout(() => row.classList.remove('msg-highlight'), 600);
    }

    function clearMsgSearchHighlights() {
        messagesContainer.querySelectorAll('.msg-highlight').forEach(el => {
            el.classList.remove('msg-highlight');
        });
    }

    // ========== 右键菜单 ==========
    function showContextMenu(x, y, msg, rowEl) {
        contextMenuTarget = msg;

        // 根据消息角色显隐菜单项（图片消息只能删除）
        const isImage = msg.type === 'image';
        const userOnly = contextMenu.querySelectorAll('.ctx-item-user-only');
        const aiOnly = contextMenu.querySelectorAll('.ctx-item-ai-only');
        const copyItem = contextMenu.querySelector('[data-action="copy"]');
        userOnly.forEach(el => el.style.display = (!isImage && msg.role === 'user') ? 'flex' : 'none');
        aiOnly.forEach(el => el.style.display = (!isImage && msg.role === 'assistant') ? 'flex' : 'none');
        if (copyItem) copyItem.style.display = isImage ? 'none' : 'flex';

        // 定位
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
        contextMenu.classList.add('active');

        // 防止超出视窗
        requestAnimationFrame(() => {
            const rect = contextMenu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                contextMenu.style.left = (x - rect.width) + 'px';
            }
            if (rect.bottom > window.innerHeight) {
                contextMenu.style.top = (y - rect.height) + 'px';
            }
        });
    }

    function hideContextMenu() {
        contextMenu.classList.remove('active');
        contextMenuTarget = null;
    }

    function handleContextAction(action) {
        if (!contextMenuTarget) return;
        const msg = contextMenuTarget;
        hideContextMenu();

        switch (action) {
            case 'copy': {
                const txt = msg.role === 'user' ? msg.content : msg.content;
                navigator.clipboard.writeText(filterAd(txt)).then(() => {
                    showToast('已复制到剪贴板', 'success', 1500);
                }).catch(() => showToast('复制失败', 'error'));
                break;
            }
            case 'edit': {
                showEditDialog(msg);
                break;
            }
            case 'regenerate': {
                regenerateMessage(msg);
                break;
            }
            case 'delete': {
                const msgs = getMessages();
                const idx = msgs.indexOf(msg);
                if (idx >= 0) {
                    msgs.splice(idx, 1);
                    saveAll();
                    rebuildMessagesUI();
                    updateStats();
                    showToast('消息已删除', 'info', 1500);
                }
                break;
            }
        }
    }

    // ========== 移动端视口适配 ==========
    // 用 visualViewport 的真实高度驱动 #app 高度：键盘弹起时布局跟着缩，
    // 输入框不会被键盘或浏览器底部导航栏挡在屏幕外
    function setupViewportFit() {
        const root = document.documentElement;
        const applyHeight = () => {
            const vv = window.visualViewport;
            // 用户手动缩放（pinch zoom）时 vv.height 会变小，此时不要干预布局
            if (vv && vv.scale > 1.05) return;
            const h = vv ? vv.height : window.innerHeight;
            if (h > 0) root.style.setProperty('--app-height', Math.round(h) + 'px');
        };
        applyHeight();

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', applyHeight);
            window.visualViewport.addEventListener('scroll', applyHeight);
        }
        window.addEventListener('resize', applyHeight);
        window.addEventListener('orientationchange', () => setTimeout(applyHeight, 150));

        // 键盘收起/弹起后，把视图拉回底部，避免停在半空
        const relayout = () => setTimeout(() => { applyHeight(); if (isNearBottom) scrollToBottom(true); }, 60);
        if (window.visualViewport) window.visualViewport.addEventListener('resize', relayout);
        window.addEventListener('resize', relayout);
    }

    // ========== 网络状态检测 ==========
    function updateNetworkStatus() {
        if (networkStatus) {
            networkStatus.classList.toggle('visible', !isOnline);
        }
    }

    // ========== 对话压缩（滚动摘要） ==========
    const SUMMARY_INSTRUCTION = `你是一个对话记忆压缩器。请把对话记录整理成一份【记忆档案】，供后续对话直接当作上下文使用。

输出结构（用小标题分节，没有内容的小节可以省略）：
- 时间坐标：这段对话发生在什么时候、跨了多久、当前处在哪个阶段（例如"从 11 月 20 日聊到 26 日，已经进入第三周"）
- 人物与设定：对方是谁、怎么称呼、身份/关系、你（AI）在这个对话里的角色
- 正在做的事：目标、已确认的决定、约定好的规则/格式/称呼、还没解决的问题
- 关键事实：具体的人名、数字、日期、路径、参数、结论；能保留原话里的关键短语就保留
- 偏好与禁忌：对方明确说过喜欢/讨厌/不要什么
- 情绪与关系：当前的氛围、最近一次明显的情绪转折（一两句即可）

写作要求：
1. 长度由信息量决定，不设固定字数：闲聊就写短（几百字），信息密集可以写到 2000 字左右，但绝不能变成逐句复述对话。
2. 按主题归并，不要按时间顺序写流水账；只有在时间跨度较大时，才用一个简短的时间线把几个关键节点串起来（例如"11-20 定了方案 → 11-23 推翻重做 → 11-26 定稿"）。
3. 如果给了【已有摘要】，把它和新内容合并成一份：仍然有效的保留，被推翻的用新结论替换，重复的合并；不要出现"之前提到过""如前所述"这类指代。
4. 不要编造对话里没有的信息，不要加评论、评价和建议。
5. 直接输出档案正文，不要前言、不要总结自己的总结。`;

    async function requestSummary(existing, chunkText) {
        const now = new Date();
        const prompt = `${SUMMARY_INSTRUCTION}

【当前时间】${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}

【已有摘要】
${existing || '（无）'}

【新增对话】
${chunkText}

【更新后的摘要】`;

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), SUMMARY_TIMEOUT);
        try {
            const resp = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt }),
                signal: ctrl.signal,
            });
            if (!resp.ok) throw new Error(`总结请求失败 HTTP ${resp.status}`);
            const reader = resp.body.getReader();
            let text = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                text += new TextDecoder().decode(value);
            }
            return filterAd(text).trim();
        } finally {
            clearTimeout(timer);
        }
    }

    // 把「保留轮数」之外的消息压缩成摘要，保留轮数内原样不动
    async function compactConversation(options = {}) {
        const { manual = true, silent = false } = options;
        if (isGenerating) return false;
        const conv = currentConv();
        if (!conv) { if (manual) showToast('当前没有对话可压缩', 'warning'); return false; }

        const keepRounds = Math.max(1, parseInt(settings.recentRounds, 10) || 10);
        const keepCount = keepRounds * 2;
        const total = conv.messages.length;
        const keep = total > keepCount ? conv.messages.slice(total - keepCount) : conv.messages.slice();
        const toCompress = total > keepCount ? conv.messages.slice(0, total - keepCount) : [];

        if (toCompress.length === 0) {
            if (manual) showToast(`对话不足 ${keepRounds} 轮，暂时不需要压缩`, 'info');
            return false;
        }
        if (manual && !confirm(`将把前面 ${toCompress.length} 条消息压缩为摘要，最近 ${keepRounds} 轮保持原文。确定吗？`)) return false;

        // 分块，避免单次请求超过接口 256KB 上限
        const chunks = [];
        let cur = '', curLen = 0;
        for (const m of toCompress) {
            const t = m.timestamp ? new Date(m.timestamp) : null;
            const stamp = t ? `[${t.getMonth() + 1}-${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}] ` : '';
            const line = stamp + (m.role === 'user' ? '用户：' : 'AI：') + msgText(m) + '\n';
            if (curLen + line.length > SUMMARY_CHUNK_CHARS && cur) { chunks.push(cur); cur = ''; curLen = 0; }
            cur += line; curLen += line.length;
        }
        if (cur) chunks.push(cur);

        isGenerating = true;
        updateInputState();
        if (!silent) renderSystemMessage('\u{1F4DD} 正在压缩对话记忆...');

        try {
            let summary = conv.summary || '';
            for (let i = 0; i < chunks.length; i++) {
                if (chunks.length > 1 && !silent) renderSystemMessage(`\u{1F4DD} 压缩中 ${i + 1}/${chunks.length}...`);
                summary = await requestSummary(summary, chunks[i]);
            }
            if (!summary) throw new Error('摘要为空');

            conv.summary = summary;
            conv.compressedCount = (conv.compressedCount || 0) + toCompress.length;
            conv.messages = keep;
            conv.updatedAt = Date.now();
            saveAll();
            rebuildMessagesUI();
            updateStats();
            if (!silent) showToast('对话已压缩，摘要已置顶', 'success');
            return true;
        } catch (e) {
            console.error('压缩失败', e);
            if (!silent) renderSystemMessage('\u26A0\ufe0F 压缩失败：' + (e.message || '请重试'));
            return false;
        } finally {
            isGenerating = false;
            updateInputState();
        }
    }

    // 顶栏按钮 / Ctrl+Shift+S 入口
    function manualSummary() { return compactConversation({ manual: true }); }

    // ========== 对话管理 ==========
    function createConversation(title, focusInput = true) {
        const id = uid();
        conversations[id] = {
            id, title: title || '新对话', titleLocked: false,
            messages: [], summary: '',
            createdAt: Date.now(), updatedAt: Date.now(),
        };
        activeConvId = id;
        saveAll();
        renderChatList();
        updateChatTitle();
        updateStats();
        clearMessagesUI();
        showWelcome();
        if (focusInput) setTimeout(() => chatInput.focus(), 100);
        return id;
    }

    function switchConversation(id) {
        if (isGenerating) {
            clearTimeout(waifu.timer);
            waifu.timer = null;
            if (abortController) abortController.abort();
        }
        if (activeConvId === id) { closeSidebar(); return; }
        activeConvId = id;
        saveAll();
        rebuildMessagesUI();
        renderChatList();
        updateChatTitle();
        closeSidebar();
    }

    function deleteConversation(id) {
        if (isGenerating) return;
        if (!confirm('确定删除这个对话吗？')) return;
        delete conversations[id];
        convDel(id).catch(e => console.error('删除对话失败', e));
        if (activeConvId === id) {
            const keys = Object.keys(conversations).sort((a, b) =>
                (conversations[b].updatedAt || 0) - (conversations[a].updatedAt || 0));
            activeConvId = keys.length > 0 ? keys[0] : null;
        }
        saveAll();
        renderChatList();
        rebuildMessagesUI();
        updateChatTitle();
        updateStats();
        showToast('对话已删除', 'info', 1500);
    }

    function clearCurrentConversation() {
        if (isGenerating) return;
        if (!confirm('清空当前对话和摘要？')) return;
        const conv = currentConv();
        if (conv) { conv.messages = []; conv.summary = ''; }
        clearMessagesUI();
        saveAll();
        updateContextUsage();
        updateStats();
        showToast('对话已清空', 'info', 1500);
    }

    async function clearAllData() {
        if (isGenerating) return;
        if (!confirm('这将清空所有对话、图片和设置，确定吗？')) return;
        conversations = {};
        activeConvId = null;
        try {
            await convTx('readwrite', st => st.clear());
            await idbDo('readwrite', st => st.clear());
        } catch (e) { console.error(e); }
        localStorage.removeItem(META_KEY);
        localStorage.removeItem(STORAGE_KEY);
        showWelcome();
        renderChatList();
        clearMessagesUI();
        updateChatTitle();
        showWelcome();
        updateStats();
        showToast('所有数据已清空', 'info');
    }

    // ========== UI 渲染 ==========
    function clearMessagesUI() {
        const children = Array.from(messagesContainer.children);
        children.forEach(child => {
            if (child.id !== 'welcome-screen') child.remove();
        });
        showWelcome();
    }

    function rebuildMessagesUI() {
        clearMessagesUI();
        const msgs = getMessages();
        if (msgs.length === 0 && !getSummary()) {
            showWelcome();
        } else {
            hideWelcome();
            if (getSummary()) renderSummaryBlock(getSummary(), currentConv() ? currentConv().compressedCount : 0);
            msgs.forEach(m => renderMessage(m, false, true));
            scrollToBottom(true);
        }
        updateContextUsage();
    }

    // 摘要块：完整内容置顶展示，可折叠
    function renderSummaryBlock(summary, compressedCount) {
        hideWelcome();
        const row = document.createElement('div');
        row.className = 'summary-row';

        const box = document.createElement('details');
        box.className = 'summary-box';
        box.open = true;

        const head = document.createElement('summary');
        head.className = 'summary-head';
        head.textContent = `\u{1F4E6} 历史记忆` + (compressedCount ? `（已压缩 ${compressedCount} 条旧消息）` : '');

        const body = document.createElement('div');
        body.className = 'summary-body';
        body.textContent = summary;

        box.appendChild(head);
        box.appendChild(body);
        row.appendChild(box);
        messagesContainer.appendChild(row);
    }

    function updateChatTitle() {
        const conv = currentConv();
        chatTitle.textContent = conv ? conv.title : '新对话';
    }

    // 日期标签
    function getDateLabel(timestamp) {
        const now = new Date();
        const date = new Date(timestamp);
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today.getTime() - 86400000);
        const weekAgo = new Date(today.getTime() - 7 * 86400000);

        if (date >= today) return '今天';
        if (date >= yesterday) return '昨天';
        if (date >= weekAgo) return '最近七天';
        return '更早';
    }

    function renderChatList() {
        chatList.innerHTML = '';
        const keys = Object.keys(conversations).sort(
            (a, b) => conversations[b].updatedAt - conversations[a].updatedAt
        );

        if (keys.length === 0) {
            chatList.innerHTML = '<div class="chat-list-empty">暂无对话记录</div>';
            return;
        }

        const filtered = searchQuery
            ? keys.filter(id => String(conversations[id].title || '').toLowerCase().includes(searchQuery.toLowerCase()))
            : keys;

        if (filtered.length === 0) {
            chatList.innerHTML = '<div class="chat-list-empty">未找到匹配的对话</div>';
            return;
        }

        // 按日期分组
        let lastDateLabel = '';
        for (const id of filtered) {
            const conv = conversations[id];
            const dateLabel = getDateLabel(conv.updatedAt);

            if (dateLabel !== lastDateLabel) {
                const dateEl = document.createElement('div');
                dateEl.className = 'chat-list-date';
                dateEl.textContent = dateLabel;
                chatList.appendChild(dateEl);
                lastDateLabel = dateLabel;
            }

            const item = document.createElement('div');
            item.className = `chat-list-item ${id === activeConvId ? 'active' : ''}`;
            item.setAttribute('role', 'listitem');

            // 最后一条消息预览
            const lastArr = Array.isArray(conv.messages) ? conv.messages : [];
            const lastOne = lastArr.length > 0 ? lastArr[lastArr.length - 1] : null;
            const lastMsg = lastOne ? (lastOne.type === 'image' ? '[图片]' : (lastOne.content || '')) : '';
            const preview = lastMsg.length > 30 ? lastMsg.slice(0, 30) + '...' : lastMsg;

            item.innerHTML = `
                <div class="item-info">
                    <span class="item-title">${escapeHTML(conv.title)}</span>
                    ${preview ? `<span class="item-preview">${escapeHTML(preview)}</span>` : ''}
                </div>
                <div class="item-actions">
                    <button class="item-action-btn" title="对话设置" data-action="rename">\u2699\ufe0f</button>
                    <button class="item-action-btn danger" title="删除" data-action="delete">\u2715</button>
                </div>
            `;
            item.querySelector('.item-info').addEventListener('click', () => switchConversation(id));
            item.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
                e.stopPropagation();
                renameConversation(id);
            });
            item.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
                e.stopPropagation();
                deleteConversation(id);
            });
            chatList.appendChild(item);
        }

        updateStats();
    }

    function updateContextUsage() {
        const el = $('#context-usage');
        if (!el) return;
        const prompt = buildPrompt('');
        const len = prompt.length;
        const bytes = utf8Bytes(prompt);
        const limit = providerMaxChars();
        const warnPct = providerWarnPercent();
        const pct = Math.min(100, Math.round((len / limit) * 100));
        const p = currentProvider();
        const extra = p.type === 'free' ? '；免费接口请求体硬上限 256 KB' : '';
        el.textContent = `上下文：${len} 字符 / ${(bytes / 1024).toFixed(1)} KB（${pct}%，上限 ${limit}${extra}）`;
        el.className = (pct >= warnPct) ? 'context-usage warning' : 'context-usage';
    }

    function updateCharCount() {
        const len = chatInput.value.length;
        charCount.textContent = len > 0 ? len : '';
        charCount.className = 'char-count';
        if (len > 800) charCount.classList.add('warning');
        if (len > 1500) charCount.classList.add('danger');
    }

    // ========== 侧边栏 ==========
    function openSidebar() {
        sidebar.classList.add('open');
        sidebarOverlay.classList.add('active');
    }

    function closeSidebar() {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
    }

    // ========== 设置面板 ==========
    // ========== 设置面板 ==========
    let editingProviderId = null;
    let editingImageProviderId = null;

    function renderProviderSelects() {
        const sel = $('#set-provider');
        if (sel) {
            sel.innerHTML = settings.providers.map(p =>
                `<option value="${p.id}">${escapeHTML(p.name)}${p.type === 'free' ? '（免费）' : ''}</option>`).join('');
            sel.value = settings.chatProviderId;
        }
        const sel2 = $('#set-imageprovider');
        if (sel2) {
            sel2.innerHTML = settings.imageProviders.map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('');
            sel2.value = settings.imageProviderId;
        }
    }

    function renderProviderList() {
        const box = $('#provider-list');
        if (!box) return;
        box.innerHTML = '';
        settings.providers.forEach(p => {
            const el = document.createElement('div');
            el.className = 'provider-item';
            const sub = p.type === 'free' ? '公益接口 · prompt 协议' : `${escapeHTML(p.baseUrl)} · ${escapeHTML(p.model || '')}`;
            el.innerHTML = `<div style="min-width:0;flex:1;"><span class="p-name">${escapeHTML(p.name)}</span><span class="p-sub">${sub}</span></div>`;
            if (p.id === settings.chatProviderId) {
                const tag = document.createElement('span');
                tag.className = 'p-tag';
                tag.textContent = '使用中';
                el.appendChild(tag);
            }
            const edit = document.createElement('button');
            edit.className = 'btn-small';
            edit.textContent = '编辑';
            edit.addEventListener('click', (e) => { e.stopPropagation(); openProviderEditor(p.id); });
            el.appendChild(edit);
            if (p.type !== 'free') {
                const del = document.createElement('button');
                del.className = 'btn-small danger';
                del.textContent = '删除';
                del.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!confirm(`删除供应商「${p.name}」？`)) return;
                    settings.providers = settings.providers.filter(x => x.id !== p.id);
                    if (settings.chatProviderId === p.id) settings.chatProviderId = settings.providers[0].id;
                    saveAll(); renderProviderList(); renderProviderSelects();
                    showToast('已删除', 'info');
                });
                el.appendChild(del);
            }
            el.addEventListener('click', () => {
                settings.chatProviderId = p.id;
                saveAll();
                renderProviderList();
                renderProviderSelects();
                showToast(`已切换到「${p.name}」`, 'success', 1500);
            });
            box.appendChild(el);
        });
    }

    function openProviderEditor(id) {
        const box = $('#provider-editor');
        editingProviderId = id || null;
        const p = id ? settings.providers.find(x => x.id === id) : null;
        $('#pe-name').value = p ? p.name : '';
        $('#pe-url').value = p ? p.baseUrl : '';
        $('#pe-key').value = p ? (p.apiKey || '') : '';
        $('#pe-model').value = p ? (p.model || '') : '';
        box.hidden = false;
    }

    function saveProviderEditor() {
        const name = $('#pe-name').value.trim() || '未命名接口';
        const baseUrl = $('#pe-url').value.trim();
        const apiKey = $('#pe-key').value.trim();
        const model = $('#pe-model').value.trim();
        if (!baseUrl) { showToast('请填写 Base URL', 'warning'); return; }
        if (editingProviderId) {
            const p = settings.providers.find(x => x.id === editingProviderId);
            if (p) { p.name = name; p.baseUrl = baseUrl; p.apiKey = apiKey; p.model = model; }
        } else {
            const np = { id: uid(), name, type: 'openai', baseUrl, apiKey, model, maxChars: 128000, warnPercent: 70 };
            settings.providers.push(np);
            settings.chatProviderId = np.id;
        }
        $('#provider-editor').hidden = true;
        editingProviderId = null;
        saveAll(); renderProviderList(); renderProviderSelects();
        showToast('已保存', 'success');
    }

    function renderImageProviderList() {
        const box = $('#imageprovider-list');
        if (!box) return;
        box.innerHTML = '';
        settings.imageProviders.forEach(p => {
            const el = document.createElement('div');
            el.className = 'provider-item';
            el.innerHTML = `<div style="min-width:0;flex:1;"><span class="p-name">${escapeHTML(p.name)}</span><span class="p-sub">${escapeHTML(p.baseUrl)} · ${escapeHTML(p.model || '')} · ${escapeHTML(p.size || '')}</span></div>`;
            if (p.id === settings.imageProviderId) {
                const tag = document.createElement('span');
                tag.className = 'p-tag';
                tag.textContent = '使用中';
                el.appendChild(tag);
            }
            const edit = document.createElement('button');
            edit.className = 'btn-small';
            edit.textContent = '编辑';
            edit.addEventListener('click', (e) => { e.stopPropagation(); openImageProviderEditor(p.id); });
            el.appendChild(edit);
            if (settings.imageProviders.length > 1) {
                const del = document.createElement('button');
                del.className = 'btn-small danger';
                del.textContent = '删除';
                del.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!confirm(`删除生图接口「${p.name}」？`)) return;
                    settings.imageProviders = settings.imageProviders.filter(x => x.id !== p.id);
                    if (settings.imageProviderId === p.id) settings.imageProviderId = settings.imageProviders[0].id;
                    saveAll(); renderImageProviderList(); renderProviderSelects();
                    showToast('已删除', 'info');
                });
                el.appendChild(del);
            }
            el.addEventListener('click', () => {
                settings.imageProviderId = p.id;
                saveAll(); renderImageProviderList(); renderProviderSelects();
                showToast(`已切换到「${p.name}」`, 'success', 1500);
            });
            box.appendChild(el);
        });
    }

    function openImageProviderEditor(id) {
        const box = $('#imageprovider-editor');
        editingImageProviderId = id || null;
        const p = id ? settings.imageProviders.find(x => x.id === id) : null;
        $('#ipe-name').value = p ? p.name : '';
        $('#ipe-url').value = p ? p.baseUrl : '';
        $('#ipe-key').value = p ? (p.apiKey || '') : '';
        $('#ipe-model').value = p ? (p.model || '') : '';
        $('#ipe-size').value = p ? (p.size || '1024x1024') : '1024x1024';
        box.hidden = false;
    }

    function saveImageProviderEditor() {
        const name = $('#ipe-name').value.trim() || '未命名生图';
        const baseUrl = $('#ipe-url').value.trim();
        const apiKey = $('#ipe-key').value.trim();
        const model = $('#ipe-model').value.trim();
        const size = $('#ipe-size').value.trim() || '1024x1024';
        if (!baseUrl) { showToast('请填写 Base URL', 'warning'); return; }
        if (editingImageProviderId) {
            const p = settings.imageProviders.find(x => x.id === editingImageProviderId);
            if (p) { p.name = name; p.baseUrl = baseUrl; p.apiKey = apiKey; p.model = model; p.size = size; }
        } else {
            const np = { id: uid(), name, baseUrl, apiKey, model: model || 'z-image-turbo', size };
            settings.imageProviders.push(np);
            settings.imageProviderId = np.id;
        }
        $('#imageprovider-editor').hidden = true;
        editingImageProviderId = null;
        saveAll(); renderImageProviderList(); renderProviderSelects();
        showToast('已保存', 'success');
    }

    async function renderImageGallery() {
        const box = $('#image-gallery');
        const cnt = $('#image-count');
        if (!box || !cnt) return;
        try {
            const all = await imgAll();
            all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            cnt.textContent = `共 ${all.length} 张`;
            box.innerHTML = '';
            if (all.length === 0) {
                box.innerHTML = '<div class="hint-text" style="padding:8px 0;">还没有生成的图片</div>';
                return;
            }
            all.forEach(rec => {
                const d = document.createElement('div');
                d.className = 'image-thumb';
                const img = document.createElement('img');
                img.src = rec.data;
                img.alt = '';
                img.addEventListener('click', () => openImageViewer(rec.data));
                const del = document.createElement('button');
                del.className = 'thumb-del';
                del.textContent = '×';
                del.title = '删除';
                del.addEventListener('click', async () => {
                    if (!confirm('删除这张图片？')) return;
                    await imgDel(rec.id);
                    renderImageGallery();
                    rebuildMessagesUI();
                });
                d.appendChild(img);
                d.appendChild(del);
                box.appendChild(d);
            });
        } catch (e) {
            cnt.textContent = '图片读取失败';
        }
    }

    function openSettings() {
        ensureProviders();
        settingsOverlay.classList.add('active');
        settingsPanel.classList.add('active');

        $('#set-theme').value = settings.colorScheme;
        $('#set-bubble').value = settings.bubbleStyle;
        $('#set-timestamp').checked = settings.showTimestamp;
        $('#set-useravatar').value = userProfile.avatar;
        $('#set-aiavatar').value = aiProfile.avatar;
        $('#set-bgurl').value = settings.backgroundImage;
        $('#set-blur').value = settings.backgroundBlur;
        $('#set-opacity').value = settings.backgroundOpacity;
        $('#set-maxlen').value = providerMaxChars();
        $('#set-warn').value = providerWarnPercent();
        const cpName = $('#ctx-provider-name');
        if (cpName) cpName.textContent = `(当前：${currentProvider().name})`;
        $('#set-rounds').value = settings.recentRounds;
        $('#set-autocompact').checked = !!settings.autoCompact;
        $('#set-waifu').checked = !!settings.waifuMode;
        $('#set-selfportrait').value = settings.selfPortrait || '';
        $('#set-systemprompt').value = settings.systemPrompt || '';
        const spStatus = $('#systemprompt-status');
        if (spStatus) spStatus.textContent = '';
        $('#blur-val').textContent = settings.backgroundBlur;
        $('#opacity-val').textContent = Math.round(settings.backgroundOpacity * 100);
        $('#provider-editor').hidden = true;
        $('#imageprovider-editor').hidden = true;

        renderProviderSelects();
        renderProviderList();
        renderImageProviderList();
        renderImageGallery();
        updateContextUsage();
    }

    function closeSettings() {
        settings.colorScheme = $('#set-theme').value;
        settings.bubbleStyle = $('#set-bubble').value;
        settings.showTimestamp = $('#set-timestamp').checked;
        settings.backgroundImage = $('#set-bgurl').value.trim();
        settings.backgroundBlur = parseFloat($('#set-blur').value) || 0;
        settings.backgroundOpacity = parseFloat($('#set-opacity').value) || 0.75;
        const cp = currentProvider();
        const wantMax = parseInt($('#set-maxlen').value, 10) || 80000;
        cp.maxChars = cp.type === 'free' ? 80000 : Math.min(1000000, Math.max(4000, wantMax));
        cp.warnPercent = Math.min(95, Math.max(30, parseInt($('#set-warn').value, 10) || 70));
        settings.maxPromptLength = cp.maxChars;
        settings.warnThreshold = Math.round(cp.maxChars * cp.warnPercent / 100);
        settings.recentRounds = Math.min(50, Math.max(1, parseInt($('#set-rounds').value, 10) || 10));
        settings.autoCompact = $('#set-autocompact').checked;
        settings.waifuMode = $('#set-waifu').checked;
        settings.selfPortrait = ($('#set-selfportrait').value || '').trim();
        settings.systemPrompt = ($('#set-systemprompt').value || '').trim();
        userProfile.avatar = $('#set-useravatar').value.trim();
        aiProfile.avatar = $('#set-aiavatar').value.trim();

        applyTheme();
        applyBackground();
        applyHighlightTheme();
        applyMode();
        saveAll();
        rebuildMessagesUI();

        settingsOverlay.classList.remove('active');
        settingsPanel.classList.remove('active');
    }

    // ========== 对话设置（名称 + 专属提示词） ==========
    function renameConversation(id) {
        const conv = conversations[id];
        if (!conv) return;
        renameInput.value = conv.title;
        const sp = $('#rename-systemprompt');
        if (sp) sp.value = conv.systemPrompt || '';
        renameOverlay.classList.add('active');
        renamePanel.classList.add('active');
        setTimeout(() => renameInput.focus(), 100);

        const confirmHandler = () => {
            const newTitle = renameInput.value.trim();
            if (newTitle && newTitle !== conv.title) {
                conv.title = newTitle;
                conv.titleLocked = true;
            }
            conv.systemPrompt = (($('#rename-systemprompt') || {}).value || '').trim();
            saveAll();
            renderChatList();
            updateChatTitle();
            updateContextUsage();
            showToast('已保存', 'success', 1500);
            closeRename();
            cleanup();
        };

        const cancelHandler = () => { closeRename(); cleanup(); };

        const keyHandler = (e) => {
            if (e.key === 'Enter' && e.target === renameInput) confirmHandler();
            if (e.key === 'Escape') cancelHandler();
        };

        const cleanup = () => {
            $('#rename-confirm').removeEventListener('click', confirmHandler);
            $('#rename-cancel').removeEventListener('click', cancelHandler);
            renameInput.removeEventListener('keydown', keyHandler);
        };

        $('#rename-confirm').addEventListener('click', confirmHandler);
        $('#rename-cancel').addEventListener('click', cancelHandler);
        renameInput.addEventListener('keydown', keyHandler);
    }

    function closeRename() {
        renameOverlay.classList.remove('active');
        renamePanel.classList.remove('active');
    }

    // ========== 模式切换 ==========
    function applyMode() {
        const wf = !!settings.waifuMode;
        const label = $('#mode-label');
        if (label) label.textContent = wf ? 'WA' : 'AI';
        const btn = $('#mode-btn');
        if (btn) btn.classList.toggle('active', wf);
        const hint = $('#input-hint');
        if (hint) hint.textContent = wf ? 'Waifu 模式：可以连着发几句，AI 会等你说完再回' : 'Enter 发送 / Shift+Enter 换行';
        updateInputState();
    }

    function toggleMode() {
        settings.waifuMode = !settings.waifuMode;
        if (!settings.waifuMode) {
            clearTimeout(waifu.timer);
            waifu.timer = null;
            waifu.remainder = '';
        }
        applyMode();
        saveAll();
        showToast(settings.waifuMode ? '已切换到 Waifu 模式' : '已切换到普通模式', 'info', 1600);
    }

    // ========== 全量导入导出 ==========
    async function exportAll() {
        try {
            showToast('正在打包数据…', 'info', 1500);
            const all = await imgAll();
            const images = {};
            all.forEach(r => { images[r.id] = { id: r.id, data: r.data, prompt: r.prompt || '', createdAt: r.createdAt || 0 }; });
            const payload = {
                app: 'aichat', version: 3, exportedAt: new Date().toISOString(),
                settings, userProfile, aiProfile, conversations, images,
            };
            const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `aichat-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            showToast('已导出（含 API Key，请妥善保管）', 'success', 3000);
        } catch (e) {
            showToast('导出失败：' + (e.message || e), 'error');
        }
    }

    async function importAll(file) {
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data || typeof data !== 'object') throw new Error('文件内容为空');
            if (!confirm('导入会合并对话并覆盖设置，确定吗？')) return;

            if (data.settings) settings = { ...settings, ...data.settings };
            if (data.userProfile) userProfile = { ...userProfile, ...data.userProfile };
            if (data.aiProfile) aiProfile = { ...aiProfile, ...data.aiProfile };
            if (data.conversations && typeof data.conversations === 'object') {
                conversations = { ...conversations, ...data.conversations };
            }
            if (data.images && typeof data.images === 'object') {
                for (const key of Object.keys(data.images)) {
                    const rec = data.images[key];
                    const value = typeof rec === 'string' ? { id: key, data: rec, createdAt: Date.now() } : rec;
                    if (value && value.id && value.data) await imgPut(value);
                }
            }
            ensureProviders();
            saveAll();
            applyTheme();
            applyBackground();
            applyHighlightTheme();
            applyMode();
            renderChatList();
            rebuildMessagesUI();
            updateStats();
            renderImageGallery();
            showToast('导入完成', 'success');
        } catch (e) {
            console.error(e);
            showToast('导入失败：' + (e.message || e), 'error');
        }
    }

    // ========== 主题与背景 ==========
    function applyTheme() {
        document.documentElement.setAttribute('data-theme', settings.colorScheme);
    }

    function applyHighlightTheme() {
        const link = $('#hljs-theme');
        if (!link) return;
        const isDark = settings.colorScheme === 'dark' ||
            (settings.colorScheme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        link.href = isDark
            ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'
            : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
    }

    function applyBackground() {
        const bgLayer = $('#bg-layer');
        const bgMask = $('#bg-mask');

        if (settings.backgroundImage) {
            bgLayer.style.backgroundImage = `url("${settings.backgroundImage}")`;
            bgLayer.style.filter = `blur(${settings.backgroundBlur}px)`;
            bgLayer.style.webkitFilter = `blur(${settings.backgroundBlur}px)`;
            bgLayer.style.display = 'block';
        } else {
            bgLayer.style.backgroundImage = 'none';
            bgLayer.style.display = 'none';
        }

        const isDark = settings.colorScheme === 'dark' ||
            (settings.colorScheme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        const alpha = 1 - settings.backgroundOpacity;
        bgMask.style.background = `rgba(${isDark ? '26,26,30' : '248,247,244'},${settings.backgroundImage ? alpha : 1})`;
    }

    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(console.warn);
        } else if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }

    // ========== 导出对话 ==========
    function exportConversation() {
        const conv = currentConv();
        if (!conv || conv.messages.length === 0) {
            showToast('当前没有对话可导出', 'warning');
            return;
        }

        let text = `对话：${conv.title}\n`;
        text += `时间：${new Date(conv.createdAt).toLocaleString()}\n`;
        text += '='.repeat(50) + '\n\n';
        const spText = (conv.systemPrompt || '').trim();
        if (spText) text += `[本对话系统提示词]\n${spText}\n\n`;
        if (conv.summary) text += `[摘要]\n${conv.summary}\n\n`;
        conv.messages.forEach(m => {
            const time = new Date(m.timestamp).toLocaleTimeString();
            const role = m.role === 'user' ? '我' : 'AI';
            text += `[${time}] ${role}：\n${m.content}\n\n`;
        });

        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat_${conv.title}_${new Date().toLocaleDateString()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('对话已导出', 'success');
    }

    // ========== 输入框 ==========
    function autoResizeInput() {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
    }

    // ========== 事件绑定 ==========
    function bindEvents() {
        // 发送
        sendBtn.addEventListener('click', () => sendMessage());
        stopBtn.addEventListener('click', stopGeneration);

        // 输入框
        chatInput.addEventListener('input', () => {
            autoResizeInput();
            updateCharCount();
            updateSendButtonState();
        });
        chatInput.addEventListener('keydown', (e) => {
            // 输入法组合输入中按回车是确认候选词，不能当成发送
            if (e.isComposing) return;
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // 移动端聚焦输入框：等键盘动画结束后重算视口，并把输入框拉到可见处
        chatInput.addEventListener('focus', () => {
            setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
                chatInput.scrollIntoView({ block: 'nearest' });
            }, 280);
        });

        // 粘贴图片提示
        chatInput.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (items) {
                for (const item of items) {
                    if (item.type.startsWith('image/')) {
                        e.preventDefault();
                        showToast('暂不支持图片输入', 'warning', 2000);
                        return;
                    }
                }
            }
        });

        // 拖拽文件提示
        inputWrapper.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            inputWrapper.classList.add('drag-over');
        });
        inputWrapper.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            inputWrapper.classList.remove('drag-over');
        });
        inputWrapper.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            inputWrapper.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) {
                showToast('暂不支持文件输入', 'warning', 2000);
            }
        });

        // 字符计数
        charCount.addEventListener('click', () => {
            const len = chatInput.value.length;
            const tokens = estimateTokens(chatInput.value);
            showToast(`字符: ${len} | 预估 tokens: ~${tokens}`, 'info', 2000);
        });

        // 滚动控制
        messagesContainer.addEventListener('scroll', () => {
            updateScrollButton();
        });

        // 滚动到底部按钮
        scrollBottomBtn.addEventListener('click', () => {
            scrollToBottom(true);
            userScrolledUp = false;
        });

        // 侧边栏
        $('#menu-btn').addEventListener('click', openSidebar);
        sidebarOverlay.addEventListener('click', closeSidebar);
        $('#new-chat-btn').addEventListener('click', () => {
            createConversation('新对话');
            closeSidebar();
        });

        // 搜索对话
        chatSearch.addEventListener('input', (e) => {
            searchQuery = e.target.value.trim();
            renderChatList();
        });

        // 顶栏按钮
        $('#summary-btn').addEventListener('click', manualSummary);
        $('#fullscreen-btn').addEventListener('click', toggleFullscreen);
        $('#settings-top-btn').addEventListener('click', openSettings);

        // 模式切换
        $('#mode-btn').addEventListener('click', toggleMode);
        $('#set-waifu').addEventListener('change', () => {
            settings.waifuMode = $('#set-waifu').checked;
            applyMode();
            saveAll();
        });

        // 聊天服务商
        $('#set-provider').addEventListener('change', (e) => {
            settings.chatProviderId = e.target.value;
            saveAll();
            renderProviderList();
            showToast('已切换聊天接口', 'success', 1500);
        });
        $('#provider-add').addEventListener('click', () => openProviderEditor(null));
        $('#pe-save').addEventListener('click', saveProviderEditor);
        $('#pe-cancel').addEventListener('click', () => { $('#provider-editor').hidden = true; editingProviderId = null; });

        // 生图服务商
        $('#set-imageprovider').addEventListener('change', (e) => {
            settings.imageProviderId = e.target.value;
            saveAll();
            renderImageProviderList();
            showToast('已切换生图接口', 'success', 1500);
        });
        $('#imageprovider-add').addEventListener('click', () => openImageProviderEditor(null));
        $('#ipe-save').addEventListener('click', saveImageProviderEditor);
        $('#ipe-cancel').addEventListener('click', () => { $('#imageprovider-editor').hidden = true; editingImageProviderId = null; });
        $('#set-selfportrait').addEventListener('change', () => {
            settings.selfPortrait = ($('#set-selfportrait').value || '').trim();
            saveAll();
        });

        // 图片管理
        $('#clear-images').addEventListener('click', async () => {
            if (!confirm('清空所有已生成的图片？对话里的图片也会变成"已删除"。')) return;
            await imgClearAll();
            renderImageGallery();
            rebuildMessagesUI();
            showToast('图片已清空', 'success');
        });

        // 全量数据
        $('#export-all').addEventListener('click', exportAll);
        $('#import-all').addEventListener('click', () => $('#import-file').click());
        $('#import-file').addEventListener('change', (e) => {
            const f = e.target.files && e.target.files[0];
            e.target.value = '';
            if (f) importAll(f);
        });

        // 系统提示词：保存 / 清空
        const persistSystemPrompt = (notify) => {
            settings.systemPrompt = ($('#set-systemprompt').value || '').trim();
            saveAll();
            updateContextUsage();
            const st = $('#systemprompt-status');
            if (st && notify) {
                st.textContent = '已保存';
                setTimeout(() => { if (st) st.textContent = ''; }, 2000);
            }
        };
        $('#save-systemprompt').addEventListener('click', () => persistSystemPrompt(true));
        $('#clear-systemprompt').addEventListener('click', () => {
            $('#set-systemprompt').value = '';
            persistSystemPrompt(false);
            showToast('系统提示词已清空', 'info');
        });

        // 消息搜索
        $('#search-msg-btn').addEventListener('click', () => toggleMsgSearch(true));
        $('#msg-search-close').addEventListener('click', () => toggleMsgSearch(false));
        msgSearchInput.addEventListener('input', (e) => {
            performMsgSearch(e.target.value);
        });
        msgSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                navigateMsgSearch(e.shiftKey ? -1 : 1);
            }
            if (e.key === 'Escape') {
                toggleMsgSearch(false);
            }
        });
        $('#msg-search-prev').addEventListener('click', () => navigateMsgSearch(-1));
        $('#msg-search-next').addEventListener('click', () => navigateMsgSearch(1));

        // 设置
        $('#sidebar-settings-btn').addEventListener('click', () => { openSettings(); closeSidebar(); });
        settingsOverlay.addEventListener('click', closeSettings);
        $('#close-settings').addEventListener('click', closeSettings);

        // 设置内部事件
        $('#set-blur').addEventListener('input', (e) => {
            $('#blur-val').textContent = e.target.value;
            settings.backgroundBlur = parseFloat(e.target.value);
            applyBackground();
        });
        $('#set-opacity').addEventListener('input', (e) => {
            $('#opacity-val').textContent = Math.round(e.target.value * 100);
            settings.backgroundOpacity = parseFloat(e.target.value);
            applyBackground();
        });
        $('#set-bgurl').addEventListener('input', (e) => {
            settings.backgroundImage = e.target.value.trim();
            applyBackground();
        });
        $('#set-bgimage').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                if (file.size > 2 * 1024 * 1024) { showToast('图片较大(>2MB)，建议使用URL', 'warning'); return; }
                const reader = new FileReader();
                reader.onload = (ev) => {
                    settings.backgroundImage = ev.target.result;
                    $('#set-bgurl').value = settings.backgroundImage;
                    applyBackground();
                };
                reader.readAsDataURL(file);
            }
        });
        $('#clear-bg').addEventListener('click', () => {
            settings.backgroundImage = '';
            $('#set-bgurl').value = '';
            $('#set-bgimage').value = '';
            applyBackground();
            saveAll();
        });

        // 头像上传
        function setupAvatarUpload(inputId, profileKey, urlInputId) {
            const input = $(inputId);
            if (!input) return;
            input.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) {
                    showToast('图片较大(>2MB)，建议使用URL', 'warning');
                    return;
                }
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const dataUrl = ev.target.result;
                    if (profileKey === 'user') {
                        userProfile.avatar = dataUrl;
                        $(urlInputId).value = dataUrl;
                    } else {
                        aiProfile.avatar = dataUrl;
                        $(urlInputId).value = dataUrl;
                    }
                    saveAll();
                    rebuildMessagesUI();
                    showToast('头像已更新', 'success', 1500);
                };
                reader.readAsDataURL(file);
            });
        }

        setupAvatarUpload('#set-userimage', 'user', '#set-useravatar');
        setupAvatarUpload('#set-aiimage', 'ai', '#set-aiavatar');

        // 头像清除
        function setupAvatarClear(btnId, profileKey, urlInputId) {
            const btn = $(btnId);
            if (!btn) return;
            btn.addEventListener('click', () => {
                if (profileKey === 'user') {
                    userProfile.avatar = '';
                } else {
                    aiProfile.avatar = '';
                }
                $(urlInputId).value = '';
                saveAll();
                rebuildMessagesUI();
                showToast('头像已清除', 'info', 1500);
            });
        }

        setupAvatarClear('#clear-useravatar', 'user', '#set-useravatar');
        setupAvatarClear('#clear-aiavatar', 'ai', '#set-aiavatar');

        // 数据操作
        $('#export-btn').addEventListener('click', exportConversation);
        $('#clear-conv').addEventListener('click', clearCurrentConversation);
        $('#clear-all').addEventListener('click', clearAllData);

        // 重命名
        renameOverlay.addEventListener('click', closeRename);

        // 编辑对话框
        editOverlay.addEventListener('click', closeEditDialog);
        $('#close-edit').addEventListener('click', closeEditDialog);
        $('#edit-cancel').addEventListener('click', closeEditDialog);
        $('#edit-confirm').addEventListener('click', confirmEdit);
        editInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                confirmEdit();
            }
            if (e.key === 'Escape') {
                closeEditDialog();
            }
        });

        // 右键菜单事件
        contextMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.ctx-item');
            if (item) {
                handleContextAction(item.dataset.action);
            }
        });

        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) {
                hideContextMenu();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideContextMenu();
            }
        });

        // 主题变化
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (settings.colorScheme === 'auto') {
                applyTheme();
                applyBackground();
                applyHighlightTheme();
            }
        });

        // 快捷键
        document.addEventListener('keydown', (e) => {
            // Ctrl+N 新建对话
            if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
                e.preventDefault();
                createConversation('新对话');
            }
            // Escape 关闭面板
            if (e.key === 'Escape') {
                if (settingsPanel.classList.contains('active')) closeSettings();
                if (renamePanel.classList.contains('active')) closeRename();
                if (editPanel.classList.contains('active')) closeEditDialog();
                if (msgSearchBar.classList.contains('active')) toggleMsgSearch(false);
                if (sidebar.classList.contains('open')) closeSidebar();
            }
            // Ctrl+Shift+S 总结
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
                e.preventDefault();
                manualSummary();
            }
            // Ctrl+F 消息搜索
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                // 只在非输入框焦点时触发
                if (document.activeElement !== chatInput && document.activeElement !== msgSearchInput) {
                    e.preventDefault();
                    toggleMsgSearch(true);
                }
            }
        });

        // 网络状态
        window.addEventListener('online', () => {
            isOnline = true;
            updateNetworkStatus();
            showToast('网络已恢复', 'success', 2000);
        });
        window.addEventListener('offline', () => {
            isOnline = false;
            updateNetworkStatus();
            showToast('网络连接已断开', 'error', 3000);
        });

        // 页面关闭/切后台时立即落盘（IndexedDB 是异步的，尽力而为）
        window.addEventListener('beforeunload', () => { saveMeta(); flushConversations(); });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') { saveMeta(); flushConversations(); }
        });

        // 移动端视口适配（地址栏 / 底部导航栏 / 软键盘）
        setupViewportFit();
    }

    // ========== 初始化 ==========
    async function init() {
        if (typeof showdown === 'undefined') { setTimeout(init, 200); return; }

        converter = new showdown.Converter({
            tables: true,
            simplifiedAutoLink: true,
            strikethrough: true,
            tasklists: true,
            openLinksInNewWindow: true,
        });

        await loadAll();

        // 一次性默认值迁移（v3）：没设过背景的用默认壁纸，遮罩透明度对齐 75%
        if (!settings._defaultsV3) {
            if (!settings.backgroundImage) settings.backgroundImage = 'https://t.alcy.cc/ycy';
            if (!settings.backgroundBlur) settings.backgroundBlur = 0;
            if (settings.backgroundOpacity === undefined || Math.abs(settings.backgroundOpacity - 0.85) < 0.001) {
                settings.backgroundOpacity = 0.75;
            }
            settings._defaultsV3 = true;
        }
        ensureProviders();

        applyTheme();
        applyBackground();
        applyHighlightTheme();
        updateNetworkStatus();
        updateSendButtonState();
        bindEvents();
        applyMode();

        welcomeGreeting.textContent = getTimeGreeting();
        welcomeTime.textContent = getTimeString();

        renderChatList();
        updateStats();

        // 恢复上次打开的对话
        if (activeConvId && conversations[activeConvId]) {
            rebuildMessagesUI();
        } else {
            clearMessagesUI();
            showWelcome();
        }
        updateChatTitle();
        renderChatList();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
