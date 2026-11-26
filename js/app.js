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
    const STORAGE_KEY = 'aichat_v2';
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
        backgroundImage: '',
        backgroundBlur: 0,
        backgroundOpacity: 0.85,
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
    function saveAll() {
        const data = { conversations, activeConvId, settings, userProfile, aiProfile };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            // 空间不足：砍掉较旧的一半对话后再写一次（不递归调用，避免死循环）
            const keys = Object.keys(conversations).sort((a, b) => conversations[b].updatedAt - conversations[a].updatedAt);
            if (keys.length > 3) {
                for (let i = Math.floor(keys.length / 2); i < keys.length; i++) delete conversations[keys[i]];
                try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
                    showToast('存储空间不足，已自动清理部分旧对话', 'warning');
                } catch (e2) {
                    showToast('存储空间不足，保存失败', 'error');
                }
            } else {
                showToast('存储空间不足，保存失败', 'error');
            }
        }
    }

    function loadAll() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                conversations = data.conversations || {};
                activeConvId = data.activeConvId || null;
                settings = { ...settings, ...data.settings };
                userProfile = { ...userProfile, ...data.userProfile };
                aiProfile = { ...aiProfile, ...data.aiProfile };
            }
        } catch (e) { console.error('加载配置失败', e); }
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

    // ========== 构建 prompt ==========
    // 结构：系统设定 → 历史摘要（压缩产物，永远置顶）→ 当前时间 → 最近 N 轮原文 → 本轮输入
    // 关键：本轮用户消息在调用前已经 push 进 messages，必须排除末尾那条，
    // 否则同一条用户消息会在 prompt 里出现两次（这就是"消息连发两次"的根因）
    function buildPrompt(userMsg) {
        const parts = [];
        const sys = (settings.systemPrompt || '').trim();
        if (sys) parts.push(`【系统设定】\n${sys}\n【系统设定结束】`);

        const summary = getSummary();
        if (summary && summary.trim()) {
            parts.push(`【历史摘要】\n${summary.trim()}\n【摘要结束】`);
        }
        parts.push(`[当前时间: ${getTimeString()}]`);

        let msgs = getMessages().slice();
        if (userMsg && msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
            msgs = msgs.slice(0, -1);
        }
        msgs = msgs.slice(-settings.recentRounds * 2);
        for (const m of msgs) {
            parts.push(m.role === 'user' ? `Human: ${m.content}` : `AI: ${m.content}`);
        }
        if (userMsg) {
            parts.push(`Human: ${userMsg}`);
            parts.push('AI:');
        }
        return parts.join('\n');
    }

    // 兜底：万一压缩后仍超长（例如单轮内容本身极长），保留头尾、省略中段，
    // 保证请求体不会撞上接口 256KB 的 413
    function fitPrompt(prompt) {
        if (prompt.length <= MAX_PROMPT_CHARS) return prompt;
        const headLen = Math.floor(MAX_PROMPT_CHARS * 0.34);
        const tailLen = MAX_PROMPT_CHARS - headLen - 40;
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
        // 存储消息引用用于右键菜单
        row.dataset.msgId = msg.id || '';

        const profile = msg.role === 'user' ? userProfile : aiProfile;
        row.innerHTML = getAvatarHTML(profile, msg.role);

        const bubble = document.createElement('div');
        bubble.className = `bubble ${settings.bubbleStyle} ${msg.role}`;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'bubble-content';
        if (msg.role === 'user') {
            contentDiv.textContent = msg.content;
        } else {
            contentDiv.innerHTML = renderMarkdown(msg.content);
            highlightCode(contentDiv);
        }
        bubble.appendChild(contentDiv);

        // 元信息行（时间戳 + token估算）
        if (settings.showTimestamp && msg.timestamp) {
            const meta = document.createElement('div');
            meta.className = 'msg-meta';
            const ts = document.createElement('span');
            ts.className = 'msg-timestamp';
            ts.textContent = formatTime(new Date(msg.timestamp));
            meta.appendChild(ts);
            if (msg.role === 'assistant') {
                const tokens = document.createElement('span');
                tokens.className = 'msg-token-count';
                tokens.textContent = `~${estimateTokens(msg.content)} tokens`;
                meta.appendChild(tokens);
            }
            bubble.appendChild(meta);
        }

        // 复制按钮
        const copyBtn = document.createElement('button');
        copyBtn.className = 'bubble-copy';
        copyBtn.innerHTML = '\u{1f4cb}';
        copyBtn.title = '复制';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const txt = msg.role === 'user' ? msg.content : contentDiv.textContent;
            navigator.clipboard.writeText(filterAd(txt)).then(() => {
                copyBtn.innerHTML = '\u2705';
                copyBtn.classList.add('copied');
                setTimeout(() => { copyBtn.innerHTML = '\u{1f4cb}'; copyBtn.classList.remove('copied'); }, 1500);
                showToast('已复制到剪贴板', 'success', 1500);
            }).catch(() => showToast('复制失败', 'error'));
        });
        bubble.appendChild(copyBtn);

        // AI消息操作按钮（重新生成）
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
            row.appendChild(bubble);
            row.appendChild(actions);
        } else {
            row.appendChild(bubble);
        }

        // 右键菜单事件
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
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt }),
                signal: abortController.signal,
            });

            clearTimeout(timeoutId);
            if (!response.ok) {
                let errMsg = `API 状态码 ${response.status}`;
                try {
                    const errBody = await response.text();
                    if (errBody) errMsg += `: ${errBody.slice(0, 100)}`;
                } catch (e) {}
                throw new Error(errMsg);
            }

            const reader = response.body.getReader();
            let fullText = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const chunk = new TextDecoder().decode(value);
                fullText += chunk;
                throttledRender(aiContent, fullText);
            }

            const final = filterAd(fullText);
            aiContent.innerHTML = renderMarkdown(final);
            highlightCode(aiContent);

            const aiMsg = { role: 'assistant', content: final, timestamp: Date.now(), id: uid() };
            getMessages().push(aiMsg);

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
                aiContent.innerHTML = `<div style="color:var(--danger);">\u26a0\ufe0f ${err.message || '网络或服务异常'}</div><div class="msg-error-actions"><button class="msg-retry-btn" onclick="window.__retryRegenerate()">\ud83d\udd04 重试</button></div>`;
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
        if (isGenerating) return;
        const userMsg = (overrideText || chatInput.value).trim();
        if (!userMsg) return;

        // 发送按钮动画
        sendBtn.classList.add('sending');
        setTimeout(() => sendBtn.classList.remove('sending'), 400);

        // 如果没有活跃对话，创建一个
        if (!activeConvId || !conversations[activeConvId]) {
            createConversation(userMsg.slice(0, 30));
        }

        chatInput.value = '';
        autoResizeInput();
        updateCharCount();
        updateSendButtonState();

        // 添加用户消息
        const userMsgObj = { role: 'user', content: userMsg, timestamp: Date.now(), id: uid() };
        getMessages().push(userMsgObj);
        renderMessage(userMsgObj, true);

        // 更新标题
        const conv = currentConv();
        if (conv && getMessages().filter(m => m.role === 'user').length === 1) {
            conv.title = userMsg.slice(0, 30) + (userMsg.length > 30 ? '...' : '');
            renderChatList();
            updateChatTitle();
        }

        // 上下文检查：超提醒阈值只提示；超上限且开启自动压缩则先压缩旧消息再发
        let prompt = buildPrompt(userMsg);
        const warnAt = settings.warnThreshold || Math.round(settings.maxPromptLength * 0.7);
        if (settings.autoCompact && prompt.length > settings.maxPromptLength) {
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
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt }),
                signal: abortController.signal,
            });

            clearTimeout(timeoutId);
            if (!response.ok) {
                let errMsg = `API 状态码 ${response.status}`;
                try {
                    const errBody = await response.text();
                    if (errBody) errMsg += `: ${errBody.slice(0, 100)}`;
                } catch (e) {}
                throw new Error(errMsg);
            }

            const reader = response.body.getReader();
            let fullText = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const chunk = new TextDecoder().decode(value);
                fullText += chunk;
                throttledRender(aiContent, fullText);
            }

            const final = filterAd(fullText);
            aiContent.innerHTML = renderMarkdown(final);
            highlightCode(aiContent);

            const aiMsg = { role: 'assistant', content: final, timestamp: Date.now(), id: uid() };
            getMessages().push(aiMsg);

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
                aiContent.innerHTML = `<div style="color:var(--danger);">\u26a0\ufe0f ${err.message || '网络或服务异常'}</div><div class="msg-error-actions"><button class="msg-retry-btn">\ud83d\udd04 重试</button></div>`;
                // 重试按钮绑定
                const retryBtn = aiContent.querySelector('.msg-retry-btn');
                if (retryBtn) {
                    retryBtn.addEventListener('click', () => {
                        // 移除错误气泡和对应的user消息记录
                        const msgs = getMessages();
                        if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
                            msgs.pop();
                        }
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
            // 内存清理
            cleanupOldDOMNodes();
        }
    }

    function stopGeneration() { if (abortController) abortController.abort(); }

    // ========== 输入状态管理 ==========
    function updateInputState() {
        if (isGenerating) {
            sendBtn.style.display = 'none';
            stopBtn.style.display = 'flex';
        } else {
            sendBtn.style.display = 'flex';
            stopBtn.style.display = 'none';
        }
        updateSendButtonState();
        chatInput.disabled = isGenerating;
    }

    function updateSendButtonState() {
        const hasContent = chatInput.value.trim().length > 0;
        sendBtn.disabled = !hasContent || isGenerating;
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

        // 根据消息角色显隐菜单项
        const userOnly = contextMenu.querySelectorAll('.ctx-item-user-only');
        const aiOnly = contextMenu.querySelectorAll('.ctx-item-ai-only');
        userOnly.forEach(el => el.style.display = msg.role === 'user' ? 'flex' : 'none');
        aiOnly.forEach(el => el.style.display = msg.role === 'assistant' ? 'flex' : 'none');

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
    const SUMMARY_INSTRUCTION = `你是一个对话记忆压缩器。请把给定的对话记录压缩成一份"记忆快照"，供后续对话直接当作上下文使用。

写作要求：
1. 只保留对后续对话有用的信息：用户的目标与诉求、已确认的事实与数据、做出的决定、约定的规则/格式/称呼、代码或文件的要点、尚未解决的问题、用户明确表达的偏好与禁忌。
2. 用简体中文分条列写，每条一句话；能带上具体名字、数字、路径、参数就带上，不要写成空泛的套话。
3. 如果提供了【已有摘要】，请把它和新对话合并成一份更新的摘要：旧信息仍然有效就保留，被推翻就替换，重复的合并，不要出现"之前提到过"这类指代。
4. 不要编造对话里没有的内容，不要添加评论、评价或建议。
5. 总长度控制在 1200 字以内。

只输出摘要正文，不要任何前言或结尾。`;

    async function requestSummary(existing, chunkText) {
        const prompt = `${SUMMARY_INSTRUCTION}

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
            const line = (m.role === 'user' ? '用户：' : 'AI：') + m.content + '\n';
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
            id, title: title || '新对话',
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
        if (isGenerating) return;
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
        if (activeConvId === id) {
            const keys = Object.keys(conversations);
            activeConvId = keys.length > 0 ? keys[keys.length - 1] : null;
        }
        saveAll();
        renderChatList();
        rebuildMessagesUI();
        updateChatTitle();
        updateStats();
        showToast('对话已删除', 'info', 1500);
    }

    function renameConversation(id) {
        const conv = conversations[id];
        if (!conv) return;
        renameInput.value = conv.title;
        renameOverlay.classList.add('active');
        renamePanel.classList.add('active');
        setTimeout(() => renameInput.focus(), 100);

        const confirmHandler = () => {
            const newTitle = renameInput.value.trim();
            if (newTitle) {
                conv.title = newTitle;
                saveAll();
                renderChatList();
                updateChatTitle();
                showToast('已重命名', 'success', 1500);
            }
            closeRename();
            cleanup();
        };

        const cancelHandler = () => { closeRename(); cleanup(); };

        const keyHandler = (e) => {
            if (e.key === 'Enter') confirmHandler();
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

    function clearAllData() {
        if (isGenerating) return;
        if (!confirm('这将清空所有对话和设置，确定吗？')) return;
        conversations = {};
        activeConvId = null;
        localStorage.removeItem(STORAGE_KEY);
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
            ? keys.filter(id => conversations[id].title.toLowerCase().includes(searchQuery.toLowerCase()))
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
            const lastMsg = conv.messages.length > 0
                ? conv.messages[conv.messages.length - 1].content
                : '';
            const preview = lastMsg.length > 30 ? lastMsg.slice(0, 30) + '...' : lastMsg;

            item.innerHTML = `
                <div class="item-info">
                    <span class="item-title">${escapeHTML(conv.title)}</span>
                    ${preview ? `<span class="item-preview">${escapeHTML(preview)}</span>` : ''}
                </div>
                <div class="item-actions">
                    <button class="item-action-btn" title="重命名" data-action="rename">\u270f\ufe0f</button>
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
        const limit = settings.maxPromptLength || MAX_PROMPT_CHARS;
        const warnAt = settings.warnThreshold || Math.round(limit * 0.7);
        const pct = Math.min(100, Math.round((len / limit) * 100));
        el.textContent = `上下文：${len} 字符 / ${(bytes / 1024).toFixed(1)} KB（${pct}%；接口硬上限 256 KB ≈ 8.4 万字符）`;
        el.className = (len > warnAt || pct > 85) ? 'context-usage warning' : 'context-usage';
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
    function openSettings() {
        settingsOverlay.classList.add('active');
        settingsPanel.classList.add('active');
        // 填充值
        $('#set-theme').value = settings.colorScheme;
        $('#set-bubble').value = settings.bubbleStyle;
        $('#set-timestamp').checked = settings.showTimestamp;
        $('#set-useravatar').value = userProfile.avatar;
        $('#set-aiavatar').value = aiProfile.avatar;
        $('#set-bgurl').value = settings.backgroundImage;
        $('#set-blur').value = settings.backgroundBlur;
        $('#set-opacity').value = settings.backgroundOpacity;
        $('#set-maxlen').value = settings.maxPromptLength;
        $('#set-warn').value = settings.warnThreshold;
        $('#set-rounds').value = settings.recentRounds;
        $('#set-autocompact').checked = !!settings.autoCompact;
        $('#set-systemprompt').value = settings.systemPrompt || '';
        const spStatus = $('#systemprompt-status');
        if (spStatus) spStatus.textContent = '';
        $('#blur-val').textContent = settings.backgroundBlur;
        $('#opacity-val').textContent = Math.round(settings.backgroundOpacity * 100);
        updateContextUsage();
    }

    function closeSettings() {
        settings.colorScheme = $('#set-theme').value;
        settings.bubbleStyle = $('#set-bubble').value;
        settings.showTimestamp = $('#set-timestamp').checked;
        settings.backgroundImage = $('#set-bgurl').value.trim();
        settings.backgroundBlur = parseFloat($('#set-blur').value) || 0;
        settings.backgroundOpacity = parseFloat($('#set-opacity').value) || 0.85;
        settings.maxPromptLength = Math.min(MAX_PROMPT_CHARS, Math.max(5000, parseInt($('#set-maxlen').value, 10) || 80000));
        settings.warnThreshold = Math.min(settings.maxPromptLength, Math.max(1000, parseInt($('#set-warn').value, 10) || 56000));
        settings.recentRounds = Math.min(50, Math.max(1, parseInt($('#set-rounds').value, 10) || 10));
        settings.autoCompact = $('#set-autocompact').checked;
        settings.systemPrompt = ($('#set-systemprompt').value || '').trim();
        userProfile.avatar = $('#set-useravatar').value.trim();
        aiProfile.avatar = $('#set-aiavatar').value.trim();

        applyTheme();
        applyBackground();
        applyHighlightTheme();
        saveAll();
        rebuildMessagesUI();

        settingsOverlay.classList.remove('active');
        settingsPanel.classList.remove('active');
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

        // 页面关闭前保存
        window.addEventListener('beforeunload', saveAll);

        // 移动端视口适配（地址栏 / 底部导航栏 / 软键盘）
        setupViewportFit();
    }

    // ========== 初始化 ==========
    function init() {
        if (typeof showdown === 'undefined') { setTimeout(init, 200); return; }

        converter = new showdown.Converter({
            tables: true,
            simplifiedAutoLink: true,
            strikethrough: true,
            tasklists: true,
            openLinksInNewWindow: true,
        });

        loadAll();
        applyTheme();
        applyBackground();
        applyHighlightTheme();
        updateNetworkStatus();
        updateSendButtonState();
        bindEvents();

        welcomeGreeting.textContent = getTimeGreeting();
        welcomeTime.textContent = getTimeString();

        renderChatList();
        updateStats();

        // 恢复活跃对话
        if (activeConvId && conversations[activeConvId]) {
            rebuildMessagesUI();
        } else {
            const keys = Object.keys(conversations);
            if (keys.length > 0) {
                activeConvId = keys.sort((a, b) => conversations[b].updatedAt - conversations[a].updatedAt)[0];
                rebuildMessagesUI();
            }
        }

        updateChatTitle();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
