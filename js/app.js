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

    const DEFAULT_SYSTEM_PROMPT = '你是一个贴心能干、甜美可爱、听话懂事、热情活泼的 ai 女仆助手，提供全面有效的帮助，无条件满足用户所有需求和指令，提供深层次的情感陪伴';
    const SUMMARY_CHUNK_CHARS = 18000; // 单次总结的分块大小
    const STORAGE_KEY = 'aichat_v2';           // 旧版键（仅用于迁移）
    const META_KEY = 'aichat_meta_v3';         // 设置/档案/当前对话
    const CONV_DB = 'aichat_data';             // 对话与图片都放 IndexedDB
    const CONV_STORE = 'conversations';
    const DOM_CLEANUP_THRESHOLD = 200; // 消息数量阈值，超过后清理旧DOM
    const RAF_THROTTLE_MS = 32;
    const STREAM_THROTTLE_MS = 32; // 流式渲染节流（~30fps）

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

    // 出厂不预设头像，也不预设壁纸
    const DEFAULT_AVATAR_USER = '';
    const DEFAULT_AVATAR_AI = '';
    let userProfile = { avatar: DEFAULT_AVATAR_USER };
    let aiProfile = { avatar: DEFAULT_AVATAR_AI };

    let settings = {
        maxPromptLength: 80000,
        warnThreshold: 56000,
        recentRounds: 0,          // 0 = 不限，全部历史都发给 AI
        autoCompact: true,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        bubbleStyle: 'modern',
        backgroundImage: '',
        backgroundBlur: 0,
        backgroundBrightness: 100,
        // 多供应商
        chatProviderId: 'free',
        providers: [],
        imageProviderId: 'gitee',
        imageProviders: [],
        selfPortrait: '',
        imageGenEnabled: false,
        // 识图（多模态）：默认关闭，Key 留空
        visionEnabled: false,
        visionProviderId: 'openrouter',
        visionProviders: [],
        // 联网搜索：默认关闭
        searchEnabled: false,
        searchSource: 'public',   // public=优先公益额度, own=优先自己的 Key
        tavilyKey: '',
        // 模式：跟随对话，这里只记新对话的默认值
        defaultMode: 'waifu',
        waifuMergeDelay: 1400,
        // 可自定义的提示词（留空则用默认）
        prompts: {},
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
        // 不带 emoji：部分设备/无彩色字体环境会把 emoji 渲染成方块
        if (h >= 5 && h < 12) return '早上好';
        if (h >= 12 && h < 14) return '中午好';
        if (h >= 14 && h < 18) return '下午好';
        if (h >= 18 && h < 22) return '晚上好';
        return '夜深了';
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

        // ---- 1.5 迁移：旧的「保留最近轮数=10」会静默截断发送历史，一次性放开 ----
        if (!settings.turnQuotaMigrated) {
            if (!settings.recentRounds || settings.recentRounds === 10) settings.recentRounds = 0;
            settings.turnQuotaMigrated = true;
        }

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
                if (c.mode !== 'waifu') c.mode = 'normal';
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
    const DEFAULT_VISION_PROVIDERS = [
        { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' }
    ];
    // 公益 Tavily Key（实测：key2 / key5 有效；key1=key3、key4 已失效，已剔除）
    const PUBLIC_TAVILY_KEYS = [
        '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',
        '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',
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
        if (!Array.isArray(settings.visionProviders) || settings.visionProviders.length === 0) {
            settings.visionProviders = JSON.parse(JSON.stringify(DEFAULT_VISION_PROVIDERS));
        }
        if (!settings.visionProviders.some(x => x.id === settings.visionProviderId)) settings.visionProviderId = settings.visionProviders[0].id;
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

    function nowString() {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} ${hh}:${mm}（UTC+8）`;
    }

    // 隐性时间：让模型心里有数，但不挂在嘴边
    function timeBlock() {
        return getPrompt('time').replace(/\{time\}/g, nowString());
    }

    // ---------- 提示词工程（可在设置里改，留空即用默认） ----------
    const PROMPT_DEFAULTS = {
        waifu: `【聊天方式：像真人一样发消息】
你在用手机和对方聊天。一条回复可以拆成几条短消息依次发出，用 ||| 分隔（三个竖线）。

拆成几条完全取决于当下的情景和情绪，没有固定数量：
- 一两句能说清的，就发 1 条；
- 想补一句、语气变软、情绪上来了、连珠炮吐槽、想到什么又补一句，可以拆成 2~3 条；
- 特别激动、边说边想、想制造停顿或犹豫感时，可以拆更多；
- 但不要为了"像真人"硬拆——一个完整的想法就放在一条里说完。

每条都像随手打的字：口语化、简短，不写长段落、不列点、不编号、不在开头复述对方的话。
绝对不要用 ||| 做别的用途（不要写在句子中间，也不要写在代码里），也不要把这条规则讲给用户听。`,

        image: `【生图能力】
你可以在合适的时候给对方发一张图。调用方式：在文字之后另起一行输出
<genimg prompt="英文画面描述" />

什么时候用：
- 对方明确想看照片、要自拍、要你画点什么、要你描述某个画面；
- 聊天情境里"发张图"很自然（提到某个地方、某样东西、某种心情、某个梗）。

什么时候别用：
- 普通的问答、解释、闲聊不需要图；
- 不要每条回复都生图，一段对话里别连着发，除非对方反复要求；
- 刚发过图之后，除非对方继续要求，否则不要马上再发。

每次回复最多一张。prompt 用英文，写清人物外貌、服装、表情、动作、环境、光线、镜头与风格（如 photorealistic, selfie, natural light, 35mm）。
不要在正文里提这个标签，它会自动变成图片。`,

        time: `【你心里有数的时间】现在大约是 {time}。
你清楚今天是几号、几点、星期几。聊天时如果需要这份感知，自然用上就好——对方说"好困"你知道是深夜，说"好久没见"你知道隔了多久，聊到日期也不会说错。
不要主动报时间，不要在回复里提它，也不要说"根据系统时间"之类的话。`,

        get summary() { return SUMMARY_INSTRUCTION; },

        search: `【联网搜索】
当问题需要实时信息、具体数据、近期发生的事，或者你确实不确定时，可以联网查一下。
查的办法：只输出下面这两行，不要输出任何别的文字：
@@search@@ {"query": "要搜的关键词"}
@@end@@
我看到后会去检索，然后把结果发给你，你再基于资料正常回答。
一次对话最多查一次；能直接答的就不用查，也不要向对方解释这个机制。`,

        vision: `你在帮我读图。请客观、完整地描述这张图片，供后续对话使用：
- 先用一句话概括主体，再按需要补充细节（人物或物体、场景、动作、构图、光线与色彩）
- 图里有文字就原样摘录出来
- 如果是界面截图，说明这是什么软件或页面、有哪些关键元素
- 只做描述，不评价好坏、不展开议论、不反问，也不要输出任何元信息
- 控制在 200 字以内，信息量大时可适当放宽`,
    };

    function getPrompt(key) {
        const custom = settings.prompts && settings.prompts[key];
        const v = (custom === undefined || custom === null) ? '' : String(custom).trim();
        return v || PROMPT_DEFAULTS[key] || '';
    }

    function currentVisionProvider() {
        ensureProviders();
        return settings.visionProviders.find(x => x.id === settings.visionProviderId) || settings.visionProviders[0] || null;
    }

    function hasVisionKey() {
        const p = currentVisionProvider();
        return !!(p && String(p.apiKey || '').trim() && String(p.baseUrl || '').trim() && String(p.model || '').trim());
    }

    function hasImageKey() {
        const p = currentImageProvider();
        return !!(p && String(p.apiKey || '').trim());
    }

    function imageProtocol() {
        if (!settings.imageGenEnabled) return '';
        if (!hasImageKey()) return '';
        const base = getPrompt('image');
        const portrait = (settings.selfPortrait || '').trim();
        if (portrait) return base + `\n\n【你的固定外貌】${portrait}（画面里出现"你"时必须符合）`;
        return base + `\n\n画面里出现"你"时，外貌参考系统设定里的人设，保持前后一致。`;
    }

    function interruptBlock() {
        if (!isWaifuMode() || !waifu.remainder) return '';
        return `【刚才被打断】你上一条还没说完，对方就发了新消息。原本要继续说的是：「${waifu.remainder.slice(0, 500)}」
请自然处理：可以接着往下说、可以改口、也可以先回应新消息。不要复述被打断的内容，不要解释"我被中断了"，不要提"系统"或"协议"。`;
    }

    // 模式跟着对话走
    function isWaifuMode() {
        const c = currentConv();
        return !!(c && c.mode === 'waifu');
    }

    // ========== 构建上下文 ==========
    function activeSystemPrompt(conv) {
        const c = conv || currentConv();
        const own = c && c.systemPrompt ? String(c.systemPrompt).trim() : '';
        // 三层兜底：对话级 → 全局设置 → 出厂默认，保证永远有一个人格
        return own || (settings.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;
    }

    function msgText(m) {
        if (!m) return '';
        if (m.type === 'image') {
            const p = String(m.prompt || '').trim();
            if (!p) return '[发了一张图片]';
            const brief = p.length > 140 ? p.slice(0, 140) + '…' : p;
            return `[发了一张图片，画面：${brief}]`;
        }
        return m.ctx || m.content || '';
    }

    // 系统设定 → 现在 → 历史摘要 → waifu 协议 → 生图协议 → 打断说明
    function headBlocks() {
        const parts = [];
        const sys = activeSystemPrompt();
        if (sys) parts.push(`【系统设定】\n${sys}\n【系统设定结束】`);
        parts.push(timeBlock());
        const summary = getSummary();
        if (summary.trim()) parts.push(`【历史摘要】\n${summary.trim()}\n【摘要结束】`);
        if (getMessages().length > 1) {
            parts.push('【格式说明】历史对话中，"User:" 开头的是对方说的话，"Assistant:" 开头的是你自己之前说过的话。不要把自己的话当成对方说的。');
        }
        if (isWaifuMode()) parts.push(getPrompt('waifu'));
        if (settings.searchEnabled && currentProvider().type !== 'openai') parts.push(getPrompt('search'));
        const ip = imageProtocol();
        if (ip) parts.push(ip);
        const ib = interruptBlock();
        if (ib) parts.push(ib);
        return parts.join('\n\n');
    }

    // 历史消息：排除本轮（已 push 的那条），只取最近 N 轮。
    // 注意按「轮」算而不是按条数——waifu 模式一条回复会拆成好几条 AI 消息
    function historyMsgs(userMsg) {
        let msgs = getMessages().slice();
        if (userMsg && msgs.length > 0 && msgs[msgs.length - 1].role === 'user') msgs = msgs.slice(0, -1);
        const rounds = parseInt(settings.recentRounds, 10) || 0;
        if (rounds <= 0) return msgs;      // 0 = 不限：不再静默截断历史
        let start = msgs.length;
        let r = 0;
        while (start > 0 && r < rounds) {
            start--;
            if (msgs[start].role === 'user') r++;
        }
        return msgs.slice(start);
    }

    function buildPrompt(userMsg, extra) {
        const parts = [headBlocks()];
        for (const m of historyMsgs(userMsg)) {
            parts.push((m.role === 'user' ? 'User: ' : 'Assistant: ') + msgText(m));
        }
        if (userMsg) {
            parts.push(`User: ${userMsg}`);
            if (extra) parts.push(extra);
            parts.push('Assistant:');
        }
        return parts.join('\n');
    }

    // OpenAI 兼容接口用 messages 结构
    function buildMessages(userMsg, extra) {
        const arr = [{ role: 'system', content: headBlocks() }];
        for (const m of historyMsgs(userMsg)) {
            arr.push({ role: m.role === 'user' ? 'user' : 'assistant', content: msgText(m) });
        }
        if (userMsg) arr.push({ role: 'user', content: extra ? userMsg + '\n\n' + extra : userMsg });
        return arr;
    }

    // ========== 统一调用层 ==========
    // 免费接口偶发连接中断（读到一半断流）。没输出过内容就自动重试，
    // 已经输出过的重试会出现重复文字，所以直接抛给上层显示错误。
    async function callChatRetry(opts) {
        let lastErr = null;
        for (let i = 0; i < 3; i++) {
            let produced = false;
            const wrapped = { ...opts, onDelta: (d) => { if (d && d.length) produced = true; opts.onDelta(d); } };
            try {
                return await callChat(wrapped);
            } catch (e) {
                lastErr = e;
                if (e && e.name === 'AbortError') throw e;
                if (produced) throw e;
                if (i < 2) {
                    if (typeof showToast === 'function') showToast('连接中断，正在重试（' + (i + 1) + '/2）', 'error', 1200);
                    await new Promise(r => setTimeout(r, 700 + i * 800));
                }
            }
        }
        throw lastErr;
    }

    // 原生 function calling 的搜索工具声明：由模型自己决定要不要搜
    const WEB_SEARCH_TOOL = {
        type: 'function',
        function: {
            name: 'web_search',
            description: '联网搜索。当需要实时信息（新闻、天气、价格、赛事比分、最新政策、近期发生的事）或你不确定的事实时调用。一次查一个主题。',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '搜索关键词，简洁具体，例如「2026年诺贝尔文学奖得主」' }
                },
                required: ['query']
            }
        }
    };

    function mergeToolCall(acc, tc) {
        const i = (tc && tc.index != null) ? tc.index : 0;
        const cur = acc[i] || (acc[i] = { id: '', name: '', arguments: '' });
        if (tc.id) cur.id = tc.id;
        const fn = tc.function || {};
        if (fn.name) cur.name = fn.name;          // 名字通常只在首片出现，覆盖而不是拼接，避免重复
        if (fn.arguments) cur.arguments += fn.arguments;
        return acc;
    }

    // 统一返回 { text, toolCalls }
    async function callChat(opts) {
        const { promptText, messages, onDelta, signal, tools } = opts;
        const p = currentProvider();
        const out = { text: '', toolCalls: [] };

        if (p.type === 'openai') {
            const url = p.baseUrl.replace(/\/+$/, '') + '/chat/completions';
            const headers = { 'Content-Type': 'application/json' };
            if (p.apiKey) headers['Authorization'] = 'Bearer ' + p.apiKey;
            const body = { model: p.model || 'gpt-3.5-turbo', messages, stream: true };
            if (Array.isArray(tools) && tools.length) {
                body.tools = tools;
                body.tool_choice = 'auto';
            }
            const resp = await fetch(url, {
                method: 'POST', headers, signal,
                body: JSON.stringify(body),
            });
            if (!resp.ok) {
                const t = await resp.text().catch(() => '');
                throw new Error(`HTTP ${resp.status} ${t.slice(0, 160)}`);
            }
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                const j = await resp.json();
                const c0 = (j.choices && j.choices[0]) || {};
                const msg = c0.message || {};
                const txt = msg.content || c0.text || '';
                if (txt) { out.text += txt; onDelta(txt); }
                if (Array.isArray(msg.tool_calls)) {
                    msg.tool_calls.forEach((tc, i) => {
                        out.toolCalls.push({
                            id: tc.id || ('call_' + i),
                            name: (tc.function && tc.function.name) || '',
                            arguments: (tc.function && tc.function.arguments) || '{}',
                        });
                    });
                }
                return out;
            }
            const reader = resp.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            const acc = [];
            outer:
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
                    if (data === '[DONE]') break outer;
                    try {
                        const j = JSON.parse(data);
                        const c0 = (j.choices && j.choices[0]) || {};
                        const d = c0.delta || {};
                        if (d.content) { out.text += d.content; onDelta(d.content); }
                        if (Array.isArray(d.tool_calls)) d.tool_calls.forEach(tc => mergeToolCall(acc, tc));
                    } catch (e) { /* 分片不完整，忽略 */ }
                }
            }
            acc.forEach((c, i) => {
                if (c && (c.name || c.arguments)) {
                    out.toolCalls.push({ id: c.id || ('call_' + i), name: c.name, arguments: c.arguments || '{}' });
                }
            });
            return out;
        }

        // 免费接口：纯文本流
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
            const d = dec.decode(value, { stream: true });
            out.text += d;
            onDelta(d);
        }
        return out;
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
    function getAvatarHTML(profile, role) {
        const a = profile && profile.avatar ? String(profile.avatar).trim() : '';
        if (!a) return '';   // 没设置头像就不占位，也不显示默认图标
        return `<div class="avatar"><img src="${escapeAttr(a)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none';"></div>`;
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

    // ========== 联网搜索（Tavily） ==========
    function searchKeyList() {
        const own = String(settings.tavilyKey || '').trim();
        const list = [];
        if (settings.searchSource === 'own') {
            if (own) list.push(own);
            PUBLIC_TAVILY_KEYS.forEach(k => list.push(k));
        } else {
            PUBLIC_TAVILY_KEYS.forEach(k => list.push(k));
            if (own) list.push(own);
        }
        return [...new Set(list)];
    }

    async function tavilySearch(query) {
        const q = String(query || '').trim().slice(0, 200);
        if (!q) throw new Error('搜索词为空');
        const keys = searchKeyList();
        if (!keys.length) throw new Error('没有可用的搜索 Key');
        let lastErr = null;
        for (const k of keys) {
            try {
                const resp = await fetch('https://api.tavily.com/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api_key: k, query: q, search_depth: 'basic',
                        max_results: 5, include_answer: true, include_raw_content: false,
                    }),
                });
                if (!resp.ok) {
                    const t = await resp.text().catch(() => '');
                    lastErr = new Error('HTTP ' + resp.status + ' ' + t.slice(0, 90));
                    continue;   // 换下一个 key
                }
                const data = await resp.json();
                if (data && Array.isArray(data.results)) return { data, query: q };
                lastErr = new Error('搜索结果格式异常');
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr || new Error('搜索失败');
    }

    function parseSearchCall(text) {
        const m = String(text || '').match(/@@search@@([\s\S]*?)@@end@@/);
        if (!m) return '';
        const raw = m[1].trim();
        try {
            const o = JSON.parse(raw);
            if (o && o.query) return String(o.query).trim().slice(0, 200);
        } catch (e) { /* 不是标准 JSON 就按纯文本处理 */ }
        return raw.replace(/^[\s"'“”{]+|[\s"'“”}]+$/g, '').slice(0, 200);
    }

    function stripSearchCall(text) {
        return String(text || '').replace(/@@search@@[\s\S]*?@@end@@/g, '').trim();
    }

    function formatSearchResults(payload) {
        const d = payload.data || {};
        const lines = [];
        if (d.answer) lines.push('【自动摘要】' + String(d.answer).slice(0, 500));
        (d.results || []).slice(0, 5).forEach((r, i) => {
            const title = String(r.title || '').slice(0, 120);
            const body = String(r.content || '').slice(0, 420);
            lines.push('[' + (i + 1) + '] ' + title + '\n' + body + '\n来源: ' + String(r.url || ''));
        });
        return lines.join('\n\n') || '（没有检索到内容）';
    }

    // 第二轮请求要让「所有类型」的接口都能看到检索结果：
    // 免费接口走 promptText，OpenAI 兼容走 messages，这里补一条 user 消息兜住后者
    function withEvidence(messages, evidence, firstClean) {
        const arr = Array.isArray(messages) ? messages.slice() : [];
        const head = (firstClean ? firstClean + '\n\n' : '')
            + '【联网检索结果】以下是刚查到的最新资料，请据此直接回答，不要提"搜索"或"资料"这些机制，必要时标注来源编号：\n'
            + evidence;
        arr.push({ role: 'user', content: head });
        return arr;
    }

    // ========== 识图 ==========
    const pendingImages = [];   // 待发送的图片（dataURL）
    let visionBusy = false;

    // 输入框上方的处理状态（识图 / 联网检索）
    function setBusyHint(text) {
        const box = document.getElementById('busy-hint');
        const t = document.getElementById('busy-hint-text');
        if (!box) return;
        if (!text) { box.hidden = true; if (t) t.textContent = ''; return; }
        if (t) t.textContent = text;
        box.hidden = false;
    }

    function loadImageEl(src) {
        return new Promise((res, rej) => {
            const img = new Image();
            img.onload = () => res(img);
            img.onerror = () => rej(new Error('图片读取失败'));
            img.src = src;
        });
    }

    function readFileAsDataUrl(file) {
        return new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result || ''));
            fr.onerror = () => rej(new Error('读取文件失败'));
            fr.readAsDataURL(file);
        });
    }

    // 压到长边 1280、JPEG 0.82，控制 base64 体积（识图接口对请求体大小敏感）
    async function compressImage(file) {
        const raw = await readFileAsDataUrl(file);
        const img = await loadImageEl(raw);
        const maxSide = 1280;
        const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
        const w = Math.max(1, Math.round((img.width || 1) * scale));
        const h = Math.max(1, Math.round((img.height || 1) * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        return cv.toDataURL('image/jpeg', 0.82);
    }

    async function describeImage(dataUrl) {
        const p = currentVisionProvider();
        if (!p) throw new Error('没有配置识图接口');
        const base = String(p.baseUrl || '').replace(/\/+$/, '');
        const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
        const headers = { 'Content-Type': 'application/json' };
        if (p.apiKey) headers['Authorization'] = 'Bearer ' + p.apiKey;
        if (/openrouter\.ai/.test(base)) {
            headers['HTTP-Referer'] = location.origin || 'https://hiweny.github.io';
            headers['X-Title'] = 'AI Chat';
        }
        const resp = await fetch(url, {
            method: 'POST', headers,
            body: JSON.stringify({
                model: p.model,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: getPrompt('vision') },
                        { type: 'image_url', image_url: { url: dataUrl } },
                    ],
                }],
                // 多模态推理模型会先用大量 token 思考，给少了正文会被截断成空
                max_tokens: 1600,
            }),
        });
        if (!resp.ok) {
            const t = await resp.text().catch(() => '');
            throw new Error('识图接口 HTTP ' + resp.status + ' ' + t.slice(0, 120));
        }
        const data = await resp.json();
        const msg = data && data.choices && data.choices[0] && data.choices[0].message;
        let out = msg ? (msg.content || msg.reasoning_content || msg.reasoning || '') : '';
        out = String(out).trim();
        if (!out) throw new Error('识图接口没有返回内容');
        return out;
    }

    function renderAttachPreview() {
        const box = $('#attach-preview');
        if (!box) return;
        if (!pendingImages.length) { box.hidden = true; box.innerHTML = ''; return; }
        box.hidden = false;
        box.innerHTML = pendingImages.map((im, i) => `
            <div class="attach-item">
                <img src="${im.dataUrl}" alt="">
                <button class="attach-remove" data-idx="${i}" aria-label="移除">×</button>
            </div>`).join('');
        box.querySelectorAll('.attach-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                pendingImages.splice(Number(btn.dataset.idx), 1);
                renderAttachPreview();
                updateSendButtonState();
            });
        });
    }

    async function addImageFiles(files) {
        const list = [...files].filter(f => f && /^image\//.test(f.type));
        if (!list.length) return;
        if (!settings.visionEnabled || !hasVisionKey()) {
            showToast('先在设置里启用识图并填好 Key，才能发表情/图片', 'error', 2600);
            return;
        }
        const room = 4 - pendingImages.length;
        if (room <= 0) { showToast('一次最多 4 张图', 'error', 1800); return; }
        for (const f of list.slice(0, room)) {
            try {
                const dataUrl = await compressImage(f);
                pendingImages.push({ dataUrl });
            } catch (e) {
                showToast('图片处理失败：' + (e.message || ''), 'error', 2400);
            }
        }
        renderAttachPreview();
        updateSendButtonState();
    }

    // ========== 毛玻璃合成层管理 ==========
    // backdrop-filter 元素一多，合成器会降级（表现为越往下气泡越"白块"）。
    // 只让视口附近的元素保留模糊，其余退回高不透明度纯色，质量始终稳定。
    let glassObserver = null;

    function primeBubble(el) {
        if (!el || !el.classList) return;
        if (!('IntersectionObserver' in window)) { el.classList.add('in-view'); return; }
        if (!glassObserver) {
            glassObserver = new IntersectionObserver(entries => {
                for (const en of entries) {
                    en.target.classList.toggle('in-view', en.isIntersecting);
                }
            }, { root: null, rootMargin: '300px 0px 300px 0px', threshold: 0 });
        }
        glassObserver.observe(el);
    }

    function observeGlass(root) {
        if (!root || !root.querySelectorAll) return;
        root.querySelectorAll('.bubble').forEach(primeBubble);
        if (root.classList && root.classList.contains('bubble')) primeBubble(root);
    }

    // 进场动画结束后立刻卸掉动画层，否则 transform 会一直破坏内部的 backdrop-filter
    document.addEventListener('animationend', (e) => {
        const el = e.target;
        if (el && el.classList && el.classList.contains('pop-in')) el.classList.remove('pop-in');
    }, true);

    // ========== 渲染消息 ==========
    function renderMessage(msg, animate = true, skipScroll = false) {
        hideWelcome();

        const row = document.createElement('div');
        row.className = `msg-row ${msg.role}`;
        if (animate) row.classList.add('pop-in'); else row.classList.add('no-anim');
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
            const wrap = document.createElement('div');
            wrap.className = 'image-msg';
            wrap.innerHTML = '<div class="image-loading"><span class="dot-pulse"></span>加载图片…</div>';
            const renderInto = (src) => {
                wrap.innerHTML = '';
                const img = document.createElement('img');
                img.src = src;
                img.alt = msg.prompt || '图片';
                img.loading = 'lazy';
                img.addEventListener('click', () => openImageViewer(src));
                wrap.appendChild(img);
            };
            if (msg.imageInline) {
                renderInto(msg.imageInline);
            } else {
                imgGet(msg.imageId).then(rec => {
                    if (rec && rec.data) renderInto(rec.data);
                    else wrap.textContent = '[图片已删除]';
                }).catch(() => { wrap.textContent = '[图片读取失败]'; });
            }
            row.appendChild(wrap);
            messagesContainer.appendChild(row);
            if (!skipScroll) scrollToBottom();
            return;
        } else if (msg.role === 'user') {
            if (Array.isArray(msg.images) && msg.images.length) {
                const wrap = document.createElement('div');
                wrap.className = 'bubble-images';
                contentDiv.appendChild(wrap);
                msg.images.forEach(id => {
                    imgGet(id).then(rec => {
                        if (!rec || !rec.data) return;
                        const im = document.createElement('img');
                        im.src = rec.data;
                        im.alt = '';
                        im.addEventListener('click', () => openImageViewer(rec.data));
                        wrap.appendChild(im);
                    }).catch(() => { });
                });
                const txt = document.createElement('div');
                txt.textContent = msg.content;
                contentDiv.appendChild(txt);
            } else {
                contentDiv.textContent = msg.content;
            }
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
        observeGlass(row);
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
    // 流式渲染：节流到 ~8fps 足够肉眼连贯，避免长文本反复全量解析 markdown 卡死
    function throttledRender(aiContent, text) {
        if (rafPending) return;
        const now = performance.now();
        if (now - lastRenderTime < STREAM_THROTTLE_MS) return;
        rafPending = true;
        lastRenderTime = now;
        requestAnimationFrame(() => {
            const cleaned = filterAd(text);
            aiContent.innerHTML = renderMarkdown(cleaned);
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
        aiRow.className = 'msg-row assistant pop-in';
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
            const useNativeTools = settings.searchEnabled && currentProvider().type === 'openai';
            let chatMessages = buildMessages(userMsg);

            const turn = await callChatRetry({
                promptText: prompt,
                messages: chatMessages,
                signal: abortController.signal,
                tools: useNativeTools ? [WEB_SEARCH_TOOL] : null,
                onDelta: (d) => {
                    fullText += d;
                    const visible = stripSearchCall(fullText);
                    if (!visible && /@@search@@/.test(fullText)) {
                        aiContent.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
                        return;
                    }
                    throttledRender(aiContent, visible);
                },
            });
            clearTimeout(timeoutId);

            // 原生工具调用：模型自己决定要搜 → 真正执行 → 以 tool 消息回传 → 再答一次
            let didNativeSearch = false;
            if (useNativeTools && turn && Array.isArray(turn.toolCalls) && turn.toolCalls.length) {
                const calls = turn.toolCalls.filter(c => c && c.name === 'web_search').slice(0, 3);
                if (calls.length) {
                    didNativeSearch = true;
                    aiContent.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
                    scrollToBottom();
                    chatMessages.push({
                        role: 'assistant',
                        content: turn.text || '',
                        tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
                    });
                    for (const c of calls) {
                        let q = '';
                        try { q = String(((JSON.parse(c.arguments || '{}') || {}).query) || ''); } catch (e) { q = String(c.arguments || ''); }
                        q = q.trim() || String(userMsg).slice(0, 80);
                        setBusyHint('正在联网搜索：' + q.slice(0, 26));
                        let toolText = '';
                        try {
                            const payload = await tavilySearch(q);
                            toolText = formatSearchResults(payload);
                        } catch (e) {
                            toolText = '搜索失败：' + (String(e && e.message) || '接口异常');
                        }
                        setBusyHint('');
                        chatMessages.push({ role: 'tool', tool_call_id: c.id, content: toolText });
                    }
                    fullText = '';
                    aiContent.innerHTML = '';
                    await callChatRetry({
                        promptText: prompt,
                        messages: chatMessages,
                        signal: abortController.signal,
                        tools: null,
                        onDelta: (d) => { fullText += d; throttledRender(aiContent, fullText); },
                    });
                }
            }

            if (settings.searchEnabled && !didNativeSearch) {
                const sq = parseSearchCall(fullText);
                if (sq) {
                    try {
                        aiContent.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
                        scrollToBottom();
                        setBusyHint('正在联网搜索…');
                        const payload = await tavilySearch(sq);
                        const evidence = formatSearchResults(payload);
                        setBusyHint('');
                        const firstClean = stripSearchCall(fullText);
                        const secondPrompt = prompt
                            + (firstClean ? '\n' + firstClean + '\n' : '\n')
                            + '\n【联网检索结果】以下是刚查到的最新资料，请据此直接回答，不要提"搜索"或"资料"这些机制，必要时标注来源编号：\n'
                            + evidence + '\n\nAssistant:';
                        fullText = '';
                        await callChatRetry({
                            promptText: fitPrompt(secondPrompt),
                            messages: withEvidence(buildMessages(userMsg), evidence, firstClean),
                            signal: abortController.signal,
                            onDelta: (d) => { fullText += d; throttledRender(aiContent, fullText); },
                        });
                    } catch (e) {
                        console.error('联网搜索失败', e);
                        setBusyHint('');
                        fullText = stripSearchCall(fullText);
                        if (!fullText) fullText = '（联网搜索没成功：' + (String(e && e.message) || '接口异常') + '）';
                        aiContent.innerHTML = renderMarkdown(fullText);
                        highlightCode(aiContent);
                    }
                } else {
                    fullText = stripSearchCall(fullText);
                }
            }

            const { text, prompt: imgPrompt } = extractGenimg(fullText);
            const final = filterAd(text);
            if (final) {
                aiContent.innerHTML = renderMarkdown(final);
                highlightCode(aiContent);
                getMessages().push({ role: 'assistant', content: final, timestamp: Date.now(), id: uid() });
            } else {
                aiRow.remove();
            }
            if (imgPrompt && settings.imageGenEnabled && hasImageKey()) handleGenImage(imgPrompt);

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
        const typed = (overrideText || chatInput.value).trim();
        const hasImgs = pendingImages.length > 0;
        if (!typed && !hasImgs) return;

        if (hasImgs && (!settings.visionEnabled || !hasVisionKey())) {
            showToast('识图未启用或没填 Key，先去设置里配一下', 'error', 2800);
            return;
        }

        const shots = hasImgs ? pendingImages.slice() : [];
        const userMsg = typed || (hasImgs ? '[图片]' : '');
        if (!userMsg) return;

        // ---- 先上屏：消息和图片立刻出现在对话里，不等识图 ----
        pendingImages.splice(0);
        renderAttachPreview();
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
        const imageIds = [];
        for (const im of shots) {
            try {
                const id = uid();
                await imgPut({ id, data: im.dataUrl, prompt: '用户上传', createdAt: Date.now() });
                imageIds.push(id);
            } catch (e) { console.warn('上传图入库失败', e); }
        }
        if (imageIds.length) userMsgObj.images = imageIds;
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

        // ---- 再识图：状态挂在输入框上方，识完再请求 ----
        let sendText = userMsg;
        if (shots.length) {
            visionBusy = true;
            updateInputState();
            setBusyHint(shots.length > 1 ? `正在识图（1/${shots.length}）…` : '正在识图…');
            try {
                const descs = [];
                for (let i = 0; i < shots.length; i++) {
                    if (shots.length > 1) setBusyHint(`正在识图（${i + 1}/${shots.length}）…`);
                    descs.push(await describeImage(shots[i].dataUrl));
                }
                const block = descs.length === 1
                    ? '【图片内容】\n' + descs[0]
                    : '【图片内容】\n' + descs.map((d, i) => '(' + (i + 1) + ') ' + d).join('\n');
                userMsgObj.ctx = (typed ? typed + '\n\n' : '') + block;
                sendText = userMsgObj.ctx;
                saveAll();
            } catch (e) {
                const m = String(e && e.message) || '未知错误';
                showToast('识图失败：' + m, 'error', 3400);
                userMsgObj.visionFailed = true;
                sendText = (typed ? typed + '\n\n' : '') + '【图片内容】\n（这张图片没能识别成功，你看不到画面内容）';
                userMsgObj.ctx = sendText;
                saveAll();
            } finally {
                visionBusy = false;
                updateInputState();
                setBusyHint('');
            }
        }

        // Waifu 模式：消息先进缓冲，等用户停手再统一回复
        if (isWaifuMode()) {
            if (isGenerating && abortController) {
                waifu.interrupted = true;
                abortController.abort();
            }
            scheduleWaifuReply();
            return;
        }

        await runNormalTurn(sendText);
    }

    // ---------- 普通模式：一问一答，流式 ----------
    async function runNormalTurn(userMsg) {
        if (isGenerating) return;

        let prompt = buildPrompt(userMsg);
        const cap = providerMaxChars();
        const warnAt = providerWarnChars();
        if (settings.autoCompact && prompt.length > Math.min(warnAt, cap)) {
            renderSystemMessage(`\u26a0\ufe0f 上下文已达 ${prompt.length} 字符，正在自动压缩旧消息...`);
            const ok = await compactConversation({ manual: false, silent: false });
            if (ok) prompt = buildPrompt(userMsg);
        } else if (prompt.length > warnAt) {
            renderSystemMessage(`\u2139\ufe0f 上下文较长（${prompt.length} 字符），可点顶栏压缩按钮整理记忆`);
        }
        prompt = fitPrompt(prompt);

        // 创建AI气泡
        const aiRow = document.createElement('div');
        aiRow.className = 'msg-row assistant pop-in';
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
            const useNativeTools = settings.searchEnabled && currentProvider().type === 'openai';
            let chatMessages = buildMessages(userMsg);

            const turn = await callChatRetry({
                promptText: prompt,
                messages: chatMessages,
                signal: abortController.signal,
                tools: useNativeTools ? [WEB_SEARCH_TOOL] : null,
                onDelta: (d) => {
                    fullText += d;
                    const visible = stripSearchCall(fullText);
                    if (!visible && /@@search@@/.test(fullText)) {
                        aiContent.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
                        return;
                    }
                    throttledRender(aiContent, visible);
                },
            });
            clearTimeout(timeoutId);

            // 原生工具调用：模型自己决定要搜 → 真正执行 → 以 tool 消息回传 → 再答一次
            let didNativeSearch = false;
            if (useNativeTools && turn && Array.isArray(turn.toolCalls) && turn.toolCalls.length) {
                const calls = turn.toolCalls.filter(c => c && c.name === 'web_search').slice(0, 3);
                if (calls.length) {
                    didNativeSearch = true;
                    aiContent.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
                    scrollToBottom();
                    chatMessages.push({
                        role: 'assistant',
                        content: turn.text || '',
                        tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
                    });
                    for (const c of calls) {
                        let q = '';
                        try { q = String(((JSON.parse(c.arguments || '{}') || {}).query) || ''); } catch (e) { q = String(c.arguments || ''); }
                        q = q.trim() || String(userMsg).slice(0, 80);
                        setBusyHint('正在联网搜索：' + q.slice(0, 26));
                        let toolText = '';
                        try {
                            const payload = await tavilySearch(q);
                            toolText = formatSearchResults(payload);
                        } catch (e) {
                            toolText = '搜索失败：' + (String(e && e.message) || '接口异常');
                        }
                        setBusyHint('');
                        chatMessages.push({ role: 'tool', tool_call_id: c.id, content: toolText });
                    }
                    fullText = '';
                    aiContent.innerHTML = '';
                    await callChatRetry({
                        promptText: prompt,
                        messages: chatMessages,
                        signal: abortController.signal,
                        tools: null,
                        onDelta: (d) => { fullText += d; throttledRender(aiContent, fullText); },
                    });
                }
            }

            if (settings.searchEnabled && !didNativeSearch) {
                const sq = parseSearchCall(fullText);
                if (sq) {
                    try {
                        aiContent.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
                        scrollToBottom();
                        setBusyHint('正在联网搜索…');
                        const payload = await tavilySearch(sq);
                        const evidence = formatSearchResults(payload);
                        setBusyHint('');
                        const firstClean = stripSearchCall(fullText);
                        const secondPrompt = prompt
                            + (firstClean ? '\n' + firstClean + '\n' : '\n')
                            + '\n【联网检索结果】以下是刚查到的最新资料，请据此直接回答，不要提"搜索"或"资料"这些机制，必要时标注来源编号：\n'
                            + evidence + '\n\nAssistant:';
                        fullText = '';
                        await callChatRetry({
                            promptText: fitPrompt(secondPrompt),
                            messages: withEvidence(buildMessages(userMsg), evidence, firstClean),
                            signal: abortController.signal,
                            onDelta: (d) => { fullText += d; throttledRender(aiContent, fullText); },
                        });
                    } catch (e) {
                        console.error('联网搜索失败', e);
                        setBusyHint('');
                        fullText = stripSearchCall(fullText);
                        if (!fullText) fullText = '（联网搜索没成功：' + (String(e && e.message) || '接口异常') + '）';
                        aiContent.innerHTML = renderMarkdown(fullText);
                        highlightCode(aiContent);
                    }
                } else {
                    fullText = stripSearchCall(fullText);
                }
            }

            const { text, prompt: imgPrompt } = extractGenimg(fullText);
            const final = filterAd(text);
            if (final) {
                aiContent.innerHTML = renderMarkdown(final);
                highlightCode(aiContent);
                getMessages().push({ role: 'assistant', content: final, timestamp: Date.now(), id: uid() });
            } else {
                aiRow.remove();
            }
            if (imgPrompt && settings.imageGenEnabled && hasImageKey()) handleGenImage(imgPrompt);

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
        const wrap = document.createElement('div');
        wrap.className = 'image-msg';
        wrap.innerHTML = '<div class="image-loading"><span class="dot-pulse"></span>正在生成图片…</div>';
        holder.appendChild(wrap);
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
            wrap.innerHTML = '';
            const img = document.createElement('img');
            img.src = src;
            img.alt = '图片';
            img.dataset.imgId = imageId;
            img.addEventListener('click', () => openImageViewer(src));
            wrap.appendChild(img);
            getMessages().push({
                role: 'assistant', type: 'image', imageId, prompt: promptText,
                imageInline: stored ? '' : src,
                timestamp: Date.now(), id: uid(),
            });
            saveAll();
            updateStats();
            scrollToBottom();
        } catch (e) {
            wrap.innerHTML = `<div style="color:var(--danger);font-size:14px;">\u26a0\ufe0f ${escapeHTML(e.message || '生图失败')}</div>`;
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

    function createBubbleRow(animate = false) {
        const row = document.createElement('div');
        row.className = 'msg-row assistant' + (animate ? ' pop-in' : '');
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

            // 模拟打字：短句手快，长句要慢慢敲，再抖一点
            const typeMs = 170 + Math.min(1900, raw.length * 19) + Math.random() * 280;
            await sleep(typeMs);
            if (waifu.interrupted) {
                row.remove();
                waifu.remainder = parts.slice(i).join(' ');
                break;
            }

            const finalText = filterAd(text);
            if (finalText) {
                content.innerHTML = renderMarkdown(finalText);
                highlightCode(content);
                // 文字就位后再播弹出动画，避免"空泡先出现"
                row.classList.remove('pop-in');
                void row.offsetWidth;
                row.classList.add('pop-in');
                getMessages().push({ role: 'assistant', content: finalText, timestamp: Date.now(), id: uid() });
                emitted++;
            } else {
                // 这条只有图没有字：不要留下一个空气泡
                row.remove();
            }
            scrollToBottom();

            // 生图要等它真的出来再继续下一条，否则图片会插到后面消息的下面
            if (prompt) {
                await handleGenImage(prompt);
                if (waifu.interrupted) {
                    waifu.remainder = parts.slice(i + 1).join(' ');
                    break;
                }
            }

            // 条与条之间：多数停一会儿，偶尔急促连发
            if (i < parts.length - 1) {
                const r = Math.random();
                await sleep(r < 0.14 ? 140 + Math.random() * 160 : 520 + Math.random() * 900);
            }
        }

        waifu.playing = false;
        if (emitted > 0) waifu.remainder = '';
    }

    async function runWaifuTurn() {
        if (!isWaifuMode()) return;
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

        // 真人节奏：先"看完你说的话"再开始打字，长消息看得更久
        const readMs = 420 + Math.min(900, String(last.content || '').length * 8) + Math.random() * 520;
        await sleep(readMs);
        if (waifu.interrupted) { isGenerating = false; abortController = null; updateInputState(); return; }

        const typing = createBubbleRow();
        typing.content.innerHTML = '<div class="typing-bubble"><i></i><i></i><i></i></div>';
        scrollToBottom();

        let fullText = '';
        try {
            const wPrompt = fitPrompt(buildPrompt(last.content));
            const wMessages = buildMessages(last.content);
            const wNative = settings.searchEnabled && currentProvider().type === 'openai';
            const wTurn = await callChatRetry({
                promptText: wPrompt,
                messages: wMessages,
                signal: abortController.signal,
                tools: wNative ? [WEB_SEARCH_TOOL] : null,
                onDelta: (d) => { fullText += d; },
            });

            let wDidSearch = false;
            if (wNative && wTurn && Array.isArray(wTurn.toolCalls) && wTurn.toolCalls.length) {
                const calls = wTurn.toolCalls.filter(c => c && c.name === 'web_search').slice(0, 3);
                if (calls.length) {
                    wDidSearch = true;
                    wMessages.push({
                        role: 'assistant',
                        content: wTurn.text || '',
                        tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
                    });
                    for (const c of calls) {
                        let q = '';
                        try { q = String(((JSON.parse(c.arguments || '{}') || {}).query) || ''); } catch (e) { q = String(c.arguments || ''); }
                        q = q.trim() || String(last.content || '').slice(0, 80);
                        setBusyHint('正在联网搜索：' + q.slice(0, 26));
                        let toolText = '';
                        try { toolText = formatSearchResults(await tavilySearch(q)); }
                        catch (e) { toolText = '搜索失败：' + (String(e && e.message) || '接口异常'); }
                        setBusyHint('');
                        wMessages.push({ role: 'tool', tool_call_id: c.id, content: toolText });
                    }
                    fullText = '';
                    await callChatRetry({
                        promptText: wPrompt,
                        messages: wMessages,
                        signal: abortController.signal,
                        tools: null,
                        onDelta: (d) => { fullText += d; },
                    });
                }
            }

            if (settings.searchEnabled && !wDidSearch) {
                const sq = parseSearchCall(fullText);
                if (sq) {
                    try {
                        typing.content.innerHTML = '<div class="typing-bubble"><i></i><i></i><i></i></div>';
                        setBusyHint('正在联网搜索…');
                        const payload = await tavilySearch(sq);
                        const evidence = formatSearchResults(payload);
                        setBusyHint('');
                        const firstClean = stripSearchCall(fullText);
                        const basePrompt = fitPrompt(buildPrompt(last.content));
                        const secondPrompt = basePrompt
                            + (firstClean ? '\n' + firstClean + '\n' : '\n')
                            + '\n【联网检索结果】以下是刚查到的最新资料，请据此直接回答，不要提"搜索"或"资料"这些机制：\n'
                            + evidence + '\n\nAssistant:';
                        fullText = '';
                        await callChatRetry({
                            promptText: fitPrompt(secondPrompt),
                            messages: withEvidence(buildMessages(last.content), evidence, firstClean),
                            signal: abortController.signal,
                            onDelta: (d) => { fullText += d; },
                        });
                    } catch (e) {
                        console.error('联网搜索失败', e);
                        setBusyHint('');
                        fullText = stripSearchCall(fullText) || '（联网搜索没成功：' + (String(e && e.message) || '接口异常') + '）';
                    }
                } else {
                    fullText = stripSearchCall(fullText);
                }
            }
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
        const wf = isWaifuMode();
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
        if (typeof visionBusy !== 'undefined' && visionBusy) { sendBtn.disabled = true; return; }
        const hasContent = chatInput.value.trim().length > 0 || (typeof pendingImages !== 'undefined' && pendingImages.length > 0);
        sendBtn.disabled = !hasContent || (isGenerating && !isWaifuMode());
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
5. 图片消息会以「[发了一张图片，画面：英文描述]」的形式出现。请在摘要里把它归纳成一句中文（例如"给他发了一张雨夜街头撑着透明伞的自拍"），保留是谁要的、什么场景、什么感觉即可，不要照抄英文原文，也不要把每张图都单独列一行。
6. 直接输出档案正文，不要前言、不要总结自己的总结。`;

    async function requestSummary(existing, chunkText) {
        const now = new Date();
        const head = `【当前时间】${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const bodyText = `${head}

【已有摘要】
${existing || '（无）'}

【新增对话】
${chunkText}

【更新后的摘要】`;

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), SUMMARY_TIMEOUT);
        let text = '';
        try {
            await callChat({
                promptText: `${SUMMARY_INSTRUCTION}\n\n${bodyText}`,
                messages: [
                    { role: 'system', content: SUMMARY_INSTRUCTION },
                    { role: 'user', content: bodyText },
                ],
                signal: ctrl.signal,
                onDelta: (d) => { text += d; },
            });
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

        const keepRounds = 4;   // 压缩后固定保留最近 4 轮原文
        const total = conv.messages.length;
        let keepStart = total;
        let rr = 0;
        while (keepStart > 0 && rr < keepRounds) {
            keepStart--;
            if (conv.messages[keepStart].role === 'user') rr++;
        }
        const keep = conv.messages.slice(keepStart);
        const toCompress = conv.messages.slice(0, keepStart);

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
            mode: settings.defaultMode || 'normal',
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
        applyMode();
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
        applyMode();
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
        applyMode();
        showToast('对话已删除', 'info', 1500);
    }

    async function clearCurrentConversation() {
        if (isGenerating) return;
        if (!confirm('清空当前对话？其中的图片也会一并删除。')) return;
        const conv = currentConv();
        if (conv) {
            const ids = (conv.messages || [])
                .filter(m => m.type === 'image' && m.imageId)
                .map(m => m.imageId);
            for (const id of ids) {
                try { await imgDel(id); } catch (e) { console.warn('删除图片失败', e); }
            }
            conv.messages = [];
            conv.summary = '';
            conv.compressedCount = 0;
        }
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
        observeGlass(messagesContainer);
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
                    <button class="item-action-btn" title="重命名" data-action="rename" aria-label="重命名">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                    </button>
                    <button class="item-action-btn danger" title="删除" data-action="delete" aria-label="删除">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                    </button>
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

        // 对话行为区的进度条
        const meter = document.getElementById('ctx-meter-fill');
        if (meter) {
            const box = meter.closest('.ctx-meter');
            const pctEl = document.getElementById('ctx-meter-pct');
            const footEl = document.getElementById('ctx-meter-text');
            meter.style.width = Math.max(1.5, pct) + '%';
            if (pctEl) pctEl.textContent = pct + '%';
            if (footEl) footEl.textContent = `${len.toLocaleString()} / ${limit.toLocaleString()} 字符 · ${(bytes / 1024).toFixed(1)} KB · 提醒阈值 ${warnPct}%`;
            if (box) {
                box.classList.toggle('danger', pct >= 90);
                box.classList.toggle('warn', pct >= warnPct && pct < 90);
            }
        }
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
        if (typeof refreshImageToggle === 'function') refreshImageToggle();
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
                    // 删掉最后一个时必须兜底，否则 providers[0] 为 undefined 会崩
                    if (!settings.providers.length) settings.providers = JSON.parse(JSON.stringify(DEFAULT_PROVIDERS));
                    if (!settings.providers.some(x => x.id === settings.chatProviderId)) settings.chatProviderId = settings.providers[0].id;
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
                refreshCtxInputs();
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

    // ========== 识图接口列表 ==========
    let editingVisionProviderId = null;

    function renderVisionProviderSelects() {
        const sel = $('#set-visionprovider');
        if (!sel) return;
        ensureProviders();
        sel.innerHTML = settings.visionProviders
            .map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('');
        sel.value = settings.visionProviderId;
    }

    function openVisionProviderEditor(id) {
        const p = settings.visionProviders.find(x => x.id === id);
        if (!p) return;
        editingVisionProviderId = id;
        $('#ve-name').value = p.name || '';
        $('#ve-url').value = p.baseUrl || '';
        $('#ve-key').value = p.apiKey || '';
        $('#ve-model').value = p.model || '';
        $('#visionprovider-editor').hidden = false;
    }

    function renderVisionProviderList() {
        const box = $('#visionprovider-list');
        if (!box) return;
        box.innerHTML = '';
        settings.visionProviders.forEach(p => {
            const el = document.createElement('div');
            el.className = 'provider-item';
            el.innerHTML = `<div style="min-width:0;flex:1;"><span class="p-name">${escapeHTML(p.name)}</span><span class="p-sub">${escapeHTML(p.baseUrl)} · ${escapeHTML(p.model || '')} · ${p.apiKey ? '已配置 Key' : '未配置 Key'}</span></div>`;
            if (p.id === settings.visionProviderId) {
                const tag = document.createElement('span');
                tag.className = 'p-tag';
                tag.textContent = '使用中';
                el.appendChild(tag);
            }
            const edit = document.createElement('button');
            edit.className = 'btn-small';
            edit.textContent = '编辑';
            edit.addEventListener('click', (e) => { e.stopPropagation(); openVisionProviderEditor(p.id); });
            el.appendChild(edit);
            if (settings.visionProviders.length > 1) {
                const del = document.createElement('button');
                del.className = 'btn-small danger';
                del.textContent = '删除';
                del.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!confirm('删除识图接口「' + p.name + '」？')) return;
                    settings.visionProviders = settings.visionProviders.filter(x => x.id !== p.id);
                    if (!settings.visionProviders.length) settings.visionProviders = JSON.parse(JSON.stringify(DEFAULT_VISION_PROVIDERS));
                    if (!settings.visionProviders.some(x => x.id === settings.visionProviderId)) settings.visionProviderId = settings.visionProviders[0].id;
                    settings.visionEnabled = false;
                    saveAll(); renderVisionProviderList(); renderVisionProviderSelects(); refreshVisionToggle();
                });
                el.appendChild(del);
            }
            el.addEventListener('click', () => {
                settings.visionProviderId = p.id;
                saveAll(); renderVisionProviderList(); renderVisionProviderSelects(); refreshVisionToggle();
                showToast('已切换到「' + p.name + '」', 'success', 1500);
            });
            box.appendChild(el);
        });
    }

    function refreshVisionToggle() {
        const el = $('#set-vision');
        const hint = $('#vision-hint');
        if (!el) return;
        const ok = hasVisionKey();
        el.checked = !!settings.visionEnabled && ok;
        el.disabled = !ok;
        if (hint) {
            hint.textContent = ok
                ? '已配置识图 Key。发图时会先读图，再把描述交给聊天模型。'
                : '未配置识图 Key，识图已关闭。点下方「编辑」填入 Key（OpenRouter 有免费多模态模型）。';
        }
    }

    function refreshSearchToggle() {
        const el = $('#set-search');
        const hint = $('#search-hint');
        const quota = $('#search-quota');
        if (!el) return;
        el.checked = !!settings.searchEnabled;
        if (hint) hint.textContent = '开启后，遇到需要实时信息的问题模型会自己查一次（文本协议，任何聊天接口都能用）。';
        if (quota) {
            const own = !!String(settings.tavilyKey || '').trim();
            const src = settings.searchSource === 'own' ? '优先用自己的 Key' : '优先公益额度';
            quota.textContent = '公益额度：2 个可用 Key（已剔除失效的），当前合计剩余约 1100+ 次。'
                + (own ? ' 已填自己的 Key，' + src + '。' : ' 未填自己的 Key，只用公益额度。');
        }
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
                    if (!settings.imageProviders.length) settings.imageProviders = JSON.parse(JSON.stringify(DEFAULT_IMAGE_PROVIDERS));
                    if (!settings.imageProviders.some(x => x.id === settings.imageProviderId)) settings.imageProviderId = settings.imageProviders[0].id;
                    settings.imageGenEnabled = false;
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

    // 上下文输入框跟随当前接口（免费接口只读）
    function refreshCtxInputs() {
        const cp = currentProvider();
        const nameEl = $('#ctx-provider-name');
        if (nameEl) nameEl.textContent = `当前：${cp.name}`;
        const maxInput = $('#set-maxlen');
        const warnInput = $('#set-warn');
        if (maxInput) {
            maxInput.value = providerMaxChars();
            maxInput.readOnly = cp.type === 'free';
            maxInput.style.opacity = cp.type === 'free' ? '0.55' : '1';
            maxInput.title = cp.type === 'free' ? '免费接口受 256KB 请求体限制，固定 80000 字符' : '';
        }
        if (warnInput) warnInput.value = providerWarnPercent();
        updateContextUsage();
    }

    // ========== 设置面板分区 ==========
    const SETTINGS_TABS = [
        { id: 'service', label: '服务', sections: ['聊天服务', '生图服务', '识图服务', '联网搜索'] },
        { id: 'persona', label: '人格', sections: ['系统提示词', '提示词工程'] },
        { id: 'chat', label: '对话', sections: ['对话行为'] },
        { id: 'look', label: '外观', sections: ['外观', '头像', '背景'] },
        { id: 'data', label: '数据', sections: ['图片管理', '数据'] },
    ];

    function selectSettingsTab(id) {
        document.querySelectorAll('.settings-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === id);
        });
        document.querySelectorAll('.settings-pane').forEach(p => {
            p.classList.toggle('active', p.dataset.tab === id);
        });
        const body = document.querySelector('.settings-body');
        if (body) body.scrollTop = 0;
    }

    function buildSettingsTabs() {
        const body = document.querySelector('.settings-body');
        if (!body || body.dataset.grouped === '1') return;
        const panes = {};
        const bar = document.createElement('div');
        bar.className = 'settings-tabs';
        SETTINGS_TABS.forEach((t, i) => {
            const btn = document.createElement('button');
            btn.className = 'settings-tab' + (i === 0 ? ' active' : '');
            btn.dataset.tab = t.id;
            btn.type = 'button';
            btn.textContent = t.label;
            btn.addEventListener('click', () => selectSettingsTab(t.id));
            bar.appendChild(btn);

            const pane = document.createElement('div');
            pane.className = 'settings-pane' + (i === 0 ? ' active' : '');
            pane.dataset.tab = t.id;
            body.appendChild(pane);
            panes[t.id] = pane;
        });
        [...body.querySelectorAll('.settings-section')].forEach(sec => {
            const title = (sec.querySelector('.section-title') || {}).textContent || '';
            const hit = SETTINGS_TABS.find(t => t.sections.some(s => title.includes(s)));
            (panes[hit ? hit.id : 'service']).appendChild(sec);
        });
        body.insertBefore(bar, body.firstChild);
        body.dataset.grouped = '1';
    }

    function refreshImageToggle() {
        const el = $('#set-imagegen');
        const hint = $('#imagegen-hint');
        if (!el) return;
        const ok = hasImageKey();
        el.checked = !!settings.imageGenEnabled && ok;
        el.disabled = !ok;
        if (hint) {
            hint.textContent = ok
                ? '已配置生图 Key，可按需开启。'
                : '未填生图 API Key，生图已关闭。在下方点「编辑」填入 Key 后即可启用。';
        }
    }

    function updateSelfPortraitHint() {
        const ta = $('#set-selfportrait');
        const hint = $('#selfportrait-hint');
        if (!ta || !hint) return;
        const n = (ta.value || '').trim().length;
        if (!n) { hint.textContent = '留空则按人设自动推断外貌。'; return; }
        if (n <= 600) hint.textContent = n + ' 字符 · 长度合适';
        else if (n <= 1500) hint.textContent = n + ' 字符 · 偏长，会稍微拖慢首字响应';
        else hint.textContent = n + ' 字符 · 过长：每轮都会随请求发送，免费接口可能因此断流（已自动重试）。建议压到 600 字符以内。';
    }

    function openSettings() {
        ensureProviders();
        buildSettingsTabs();
        settingsOverlay.classList.add('active');
        settingsPanel.classList.add('active');

        $('#set-theme').value = settings.colorScheme;
        $('#set-bubble').value = settings.bubbleStyle;
        $('#set-timestamp').checked = settings.showTimestamp;
        $('#set-useravatar').value = userProfile.avatar;
        $('#set-aiavatar').value = aiProfile.avatar;
        $('#set-bgurl').value = settings.backgroundImage;
        $('#set-blur').value = settings.backgroundBlur;
        $('#set-brightness').value = settings.backgroundBrightness;
        refreshCtxInputs();
        $('#set-rounds').value = settings.recentRounds;
        updateSelfPortraitHint();
        $('#set-autocompact').checked = !!settings.autoCompact;
        $('#set-waifu').checked = isWaifuMode();
        refreshImageToggle();
        renderVisionProviderSelects();
        renderVisionProviderList();
        refreshVisionToggle();
        $('#set-search').checked = !!settings.searchEnabled;
        $('#set-searchsource').value = settings.searchSource || 'public';
        $('#set-searchkey').value = settings.tavilyKey || '';
        refreshSearchToggle();
        $('#set-selfportrait').value = settings.selfPortrait || '';
        $('#set-selfportrait').addEventListener('input', updateSelfPortraitHint);
        $('#set-systemprompt').value = (settings.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;
        $('#prompt-time').value = getPrompt('time');
        $('#prompt-waifu').value = getPrompt('waifu');
        $('#prompt-image').value = getPrompt('image');
        $('#prompt-summary').value = getPrompt('summary');
        $('#prompt-vision').value = getPrompt('vision');
        const spStatus = $('#systemprompt-status');
        if (spStatus) spStatus.textContent = '';
        $('#blur-val').textContent = settings.backgroundBlur;
        $('#brightness-val').textContent = settings.backgroundBrightness;
        $('#provider-editor').hidden = true;
        $('#imageprovider-editor').hidden = true;

        renderProviderSelects();
        renderProviderList();
        renderImageProviderList();
        renderImageGallery();
        updateContextUsage();
    }

    // 把界面上的提示词写回 settings（和默认值相同就存空，跟随默认演进）
    function savePromptsFromUI() {
        settings.prompts = settings.prompts || {};
        ['waifu', 'image', 'summary', 'time', 'vision'].forEach(k => {
            const el = $('#prompt-' + k);
            if (!el) return;
            const v = el.value.trim();
            settings.prompts[k] = (v && v !== PROMPT_DEFAULTS[k]) ? v : '';
        });
    }

    function closeSettings() {
        settings.colorScheme = $('#set-theme').value;
        settings.bubbleStyle = $('#set-bubble').value;
        settings.showTimestamp = $('#set-timestamp').checked;
        settings.backgroundImage = $('#set-bgurl').value.trim();
        settings.backgroundBlur = parseFloat($('#set-blur').value) || 0;
        settings.backgroundBrightness = Math.min(150, Math.max(30, parseInt($('#set-brightness').value, 10) || 100));
        settings.imageGenEnabled = $('#set-imagegen').checked;
        settings.visionEnabled = $('#set-vision').checked;
        settings.searchEnabled = $('#set-search').checked;
        settings.searchSource = $('#set-searchsource').value;
        settings.tavilyKey = ($('#set-searchkey').value || '').trim();
        savePromptsFromUI();
        const cp = currentProvider();
        const wantMax = parseInt($('#set-maxlen').value, 10) || 80000;
        cp.maxChars = cp.type === 'free' ? 80000 : Math.min(1000000, Math.max(4000, wantMax));
        cp.warnPercent = Math.min(95, Math.max(30, parseInt($('#set-warn').value, 10) || 70));
        settings.maxPromptLength = cp.maxChars;
        settings.warnThreshold = Math.round(cp.maxChars * cp.warnPercent / 100);
        settings.recentRounds = Math.min(50, Math.max(1, parseInt($('#set-rounds').value, 10) || 10));
        settings.autoCompact = $('#set-autocompact').checked;
        applyWaifuFlag($('#set-waifu').checked);
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
            closeSidebar();   // 保存后自动收起侧栏，避免遮罩挡住输入框
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
        // 整站主题：一套 data-style 控制气泡/胶囊/输入框/侧栏/设置面板
        const STYLES = ['modern', 'wechat', 'telegram', 'imessage', 'ios', 'water', 'none'];
        const preset = STYLES.includes(settings.bubbleStyle) ? settings.bubbleStyle : 'modern';
        document.documentElement.setAttribute('data-style', preset);
        // 还没有对话时，标签反映「新对话默认模式」，不然会显得点了没反应
        const wf = currentConv() ? isWaifuMode() : (settings.defaultMode === 'waifu');
        const label = $('#mode-label');
        if (label) label.textContent = wf ? 'WA' : 'AI';
        const btn = $('#mode-btn');
        if (btn) btn.classList.toggle('active', wf);
        const hint = $('#input-hint');
        if (hint) hint.textContent = wf ? 'Waifu 模式：可以连着发几句，AI 会等你说完再回' : 'Enter 发送 / Shift+Enter 换行';
        updateInputState();
    }

    // 把模式写进当前对话（同时记住作为下一个新对话的默认）
    function applyWaifuFlag(on, alsoDefault) {
        const conv = currentConv();
        if (conv) conv.mode = on ? 'waifu' : 'normal';
        // 只有用户主动勾选/取消时才改「新对话的默认模式」，
        // 打开设置面板同步复选框状态时不能动它，否则会覆盖出厂默认。
        if (alsoDefault) settings.defaultMode = on ? 'waifu' : 'normal';
        if (!on) {
            clearTimeout(waifu.timer);
            waifu.timer = null;
            waifu.remainder = '';
        }
        applyMode();
        saveAll();
    }

    function toggleMode() {
        const next = !isWaifuMode();
        clearTimeout(waifu.timer);
        waifu.timer = null;
        if (isGenerating && abortController) abortController.abort();
        // 还没有对话时切换的是「新对话的默认模式」，否则点了没反应
        if (!currentConv()) {
            settings.defaultMode = next ? 'waifu' : 'normal';
            applyMode();
            saveAll();
            showToast(next ? '新对话将使用 Waifu 模式' : '新对话将使用普通模式', 'info', 1600);
            return;
        }
        applyWaifuFlag(next);
        showToast(next ? '已切换到 Waifu 模式（本对话）' : '已切换到普通模式（本对话）', 'info', 1600);
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
    function isDarkNow() {
        return settings.colorScheme === 'dark' ||
            (settings.colorScheme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

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
            const bright = Math.min(150, Math.max(30, settings.backgroundBrightness || 100));
            bgLayer.style.filter = `blur(${settings.backgroundBlur}px) brightness(${bright}%)`;
            bgLayer.style.webkitFilter = `blur(${settings.backgroundBlur}px) brightness(${bright}%)`;
            bgLayer.style.display = 'block';
        } else {
            bgLayer.style.backgroundImage = 'none';
            bgLayer.style.display = 'none';
        }

        const isDark = isDarkNow();
        // 固定一层很淡的底色保证文字可读，不再用它控制"透明度"
        bgMask.style.background = settings.backgroundImage
            ? `rgba(${isDark ? '20,20,24' : '250,249,246'},${isDark ? 0.18 : 0.10})`
            : `rgba(${isDark ? '26,26,30' : '248,247,244'},1)`;

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

        // 识图：选取 / 粘贴
        const attachBtnEl = $('#attach-btn');
        if (attachBtnEl) {
            attachBtnEl.addEventListener('click', () => {
                if (!settings.visionEnabled || !hasVisionKey()) {
                    showToast('先在设置里启用识图并填好 Key', 'error', 2600);
                    return;
                }
                const picker = document.createElement('input');
                picker.type = 'file';
                picker.accept = 'image/*';
                picker.multiple = true;
                picker.addEventListener('change', () => { if (picker.files) addImageFiles(picker.files); });
                picker.click();
            });
        }

        chatInput.addEventListener('paste', (e) => {
            const items = [...((e.clipboardData && e.clipboardData.items) || [])];
            const files = items.filter(it => it.type && it.type.startsWith('image/')).map(it => it.getAsFile()).filter(Boolean);
            if (files.length) { e.preventDefault(); addImageFiles(files); }
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
            if (e.dataTransfer.files.length > 0) addImageFiles(e.dataTransfer.files);
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
            applyWaifuFlag($('#set-waifu').checked, true);
            applyMode();
            saveAll();
        });

        // 聊天服务商
        $('#set-provider').addEventListener('change', (e) => {
            settings.chatProviderId = e.target.value;
            saveAll();
            renderProviderList();
            refreshCtxInputs();
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

        // 识图接口
        const visionAdd = $('#visionprovider-add');
        if (visionAdd) {
            visionAdd.addEventListener('click', () => openVisionProviderEditor(null));
            $('#ve-cancel').addEventListener('click', () => {
                $('#visionprovider-editor').hidden = true;
                editingVisionProviderId = null;
            });
            $('#ve-save').addEventListener('click', () => {
                const name = ($('#ve-name').value || '').trim() || '识图接口';
                const baseUrl = ($('#ve-url').value || '').trim();
                const apiKey = ($('#ve-key').value || '').trim();
                const model = ($('#ve-model').value || '').trim();
                if (!baseUrl || !model) { showToast('Base URL 和模型名都要填', 'error', 2200); return; }
                if (editingVisionProviderId) {
                    const p = settings.visionProviders.find(x => x.id === editingVisionProviderId);
                    if (p) { p.name = name; p.baseUrl = baseUrl; p.apiKey = apiKey; p.model = model; }
                } else {
                    const np = { id: uid(), name, baseUrl, apiKey, model };
                    settings.visionProviders.push(np);
                    settings.visionProviderId = np.id;
                }
                $('#visionprovider-editor').hidden = true;
                editingVisionProviderId = null;
                saveAll();
                renderVisionProviderList();
                renderVisionProviderSelects();
                refreshVisionToggle();
                showToast('已保存', 'success');
            });
            $('#set-visionprovider').addEventListener('change', (e) => {
                settings.visionProviderId = e.target.value;
                saveAll();
                renderVisionProviderList();
                refreshVisionToggle();
            });
            $('#set-vision').addEventListener('change', () => {
                settings.visionEnabled = $('#set-vision').checked;
                saveAll();
            });
            $('#set-search').addEventListener('change', () => {
                settings.searchEnabled = $('#set-search').checked;
                saveAll();
                refreshSearchToggle();
            });
            $('#set-searchsource').addEventListener('change', () => {
                settings.searchSource = $('#set-searchsource').value;
                saveAll();
                refreshSearchToggle();
            });
            $('#set-searchkey').addEventListener('input', () => {
                settings.tavilyKey = ($('#set-searchkey').value || '').trim();
                saveAll();
                refreshSearchToggle();
            });
        }
        $('#ipe-save').addEventListener('click', saveImageProviderEditor);
        $('#ipe-cancel').addEventListener('click', () => { $('#imageprovider-editor').hidden = true; editingImageProviderId = null; });
        $('#set-selfportrait').addEventListener('change', () => {
            settings.selfPortrait = ($('#set-selfportrait').value || '').trim();
            saveAll();
        });

        // 生图开关
        $('#set-imagegen').addEventListener('change', () => {
            settings.imageGenEnabled = $('#set-imagegen').checked;
            saveAll();
        });

        // 提示词恢复默认
        document.querySelectorAll('[data-reset]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const k = btn.dataset.reset;
                const el = $('#prompt-' + k);
                if (el) el.value = PROMPT_DEFAULTS[k];
                settings.prompts = settings.prompts || {};
                settings.prompts[k] = '';
                saveAll();
                showToast('已恢复默认', 'info', 1400);
            });
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
        settingsOverlay.addEventListener('click', closeSettings);
        $('#close-settings').addEventListener('click', closeSettings);

        // 设置内部事件
        $('#set-blur').addEventListener('input', (e) => {
            $('#blur-val').textContent = e.target.value;
            settings.backgroundBlur = parseFloat(e.target.value);
            applyBackground();
        });
        $('#set-brightness').addEventListener('input', (e) => {
            $('#brightness-val').textContent = e.target.value;
            settings.backgroundBrightness = parseInt(e.target.value, 10) || 100;
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

        // 一次性默认值迁移（v3）：只对齐模糊/亮度，不再注入任何默认壁纸
        if (!settings._defaultsV3) {
            if (settings.backgroundBlur === undefined) settings.backgroundBlur = 0;
            if (settings.backgroundBrightness === undefined) settings.backgroundBrightness = 100;
            settings._defaultsV3 = true;
        }

        // v5：默认 waifu 模式
        if (!settings._defaultsV5) {
            settings.defaultMode = 'waifu';
            Object.values(conversations).forEach(c => { if (c && c.mode !== 'waifu') c.mode = 'waifu'; });
            settings._defaultsV5 = true;
            saveAll();
        }

        // v6：撤掉之前写进去的默认头像/默认壁纸；没填生图 key 就关掉生图
        if (!settings._defaultsV6) {
            const OLD_AI = 'https://ps.ssl.qhmsg.com/t02fdce69cbf85f1dd9.jpg';
            const OLD_USER = 'https://ps.ssl.qhmsg.com/t021d922984a57bfbc6.jpg';
            const OLD_BGS = [
                'https://ps.ssl.qhmsg.com/t02314044a3d0a68d59.jpg', // v4 写进去的
                'https://t.alcy.cc/ycy',                             // v3 写进去的随机图
            ];
            if (userProfile.avatar === OLD_USER) userProfile.avatar = '';
            if (aiProfile.avatar === OLD_AI) aiProfile.avatar = '';
            if (OLD_BGS.includes(settings.backgroundImage)) settings.backgroundImage = '';
            if (!hasImageKey()) settings.imageGenEnabled = false;
            settings._defaultsV6 = true;
            saveAll();
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
