// ============================================================
// AI Chat - 智能对话 App v2.0 (重构版)
// 完整独立版 - 基于免费API
// ============================================================

(function () {
    'use strict';

    // ========== 配置 ==========
    const API_URL = 'https://free-api.cnmwx.com/v1/completions';
    const REQUEST_TIMEOUT = 45000;
    const STORAGE_KEY = 'aichat_v2';
    const DOM_CLEANUP_THRESHOLD = 200;
    const RAF_THROTTLE_MS = 32;

    // ========== 增强广告过滤规则 ==========
    const AD_FILTERS = [
        /欢迎使用\s*公益站!\s*站长合作邮箱：wxgpt@qq\.com/gi,
        /<br\s*\/?>/gi,
        /公益站.*?站长合作邮箱/gi,
        /https?:\/\/wxgpt\.qq\.com/gi,
        /请勿用于.*?违规用途/gi,
        /本站不承担.*?责任/gi,
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
        maxPromptLength: 3000,
        recentRounds: 8,
        bubbleStyle: 'modern',
        backgroundImage: '',
        backgroundBlur: 0,
        backgroundOpacity: 0.85,
        colorScheme: 'auto',
        showTimestamp: false,
    };

    let userScrolledUp = false;
    let isNearBottom = true;

    let msgSearchMatches = [];
    let msgSearchIndex = -1;

    let contextMenuTarget = null;

    let rafPending = false;
    let lastRenderTime = 0;

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

    const filterAd = (text) => {
        let cleaned = text;
        for (const regex of AD_FILTERS) {
            cleaned = cleaned.replace(regex, '');
        }
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        return cleaned.trim();
    };

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

    function saveAll() {
        const data = { conversations, activeConvId, settings, userProfile, aiProfile };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            const keys = Object.keys(conversations);
            if (keys.length > 10) {
                const sorted = keys.sort((a, b) => conversations[b].updatedAt - conversations[a].updatedAt);
                for (let i = 5; i < sorted.length; i++) {
                    delete conversations[sorted[i]];
                }
                try { saveAll(); } catch (e2) { showToast('存储空间不足，已自动清理旧对话', 'warning'); }
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

    function updateStats() {
        const convCount = Object.keys(conversations).length;
        let msgCount = 0;
        for (const id of Object.keys(conversations)) {
            msgCount += conversations[id].messages.length;
        }
        if (statsConvCount) statsConvCount.textContent = `${convCount} 个对话`;
        if (statsMsgCount) statsMsgCount.textContent = `${msgCount} 条消息`;
    }

    function buildPrompt(userMsg) {
        const parts = [];
        parts.push(`[当前时间: ${getTimeString()}]`);
        const summary = getSummary();
        if (summary.trim()) parts.push(`[对话历史摘要]\n${summary}`);
        const msgs = getMessages().slice(-settings.recentRounds * 2);
        for (const m of msgs) {
            parts.push(m.role === 'user' ? `Human: ${m.content}` : `AI: ${m.content}`);
        }
        parts.push(`Human: ${userMsg}`);
        parts.push('AI:');
        return parts.join('\n');
    }

    function renderMarkdown(text) {
        if (!converter) return escapeHTML(text);
        let html = converter.makeHtml(text);
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

    function getAvatarHTML(profile, role, size = 36) {
        if (profile.avatar && profile.avatar.trim()) {
            return `<div class="avatar"><img src="${escapeAttr(profile.avatar)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
            <div class="avatar-default avatar-${role}" style="display:none;">${role === 'user' ? '\ud83d\ude0a' : '\ud83e\udd16'}</div></div>`;
        }
        const emoji = role === 'user' ? '\ud83d\ude0a' : '\ud83e\udd16';
        return `<div class="avatar"><div class="avatar-default avatar-${role}">${emoji}</div></div>`;
    }

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

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

    function renderMessage(msg, animate = true, skipScroll = false) {
        hideWelcome();

        const row = document.createElement('div');
        row.className = `msg-row ${msg.role}`;
        if (!animate) row.classList.add('no-anim');
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

    async function regenerateMessage(msg) {
        if (isGenerating) return;
        const msgs = getMessages();
        const idx = msgs.indexOf(msg);
        if (idx < 0) return;
        if (idx === 0 || msgs[idx - 1].role !== 'user') {
            showToast('无法重新生成此消息', 'warning');
            return;
        }
        msgs.splice(idx, 1);
        rebuildMessagesUI();
        const userMsg = msgs[idx - 1].content;
        await sendForRegenerate(userMsg);
    }

    async function sendForRegenerate(userMsg) {
        if (isGenerating) return;
        const prompt = buildPrompt(userMsg);
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

    window.__retryRegenerate = function () {
        const msgs = getMessages();
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') {
                const userMsg = msgs[i].content;
                rebuildMessagesUI();
                sendForRegenerate(userMsg);
                return;
            }
        }
    };

    async function sendMessage(overrideText) {
        if (isGenerating) return;
        const userMsg = (overrideText || chatInput.value).trim();
        if (!userMsg) return;

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
        if (conv && getMessages().filter(m => m.role === 'user').length === 1) {
            conv.title = userMsg.slice(0, 30) + (userMsg.length > 30 ? '...' : '');
            renderChatList();
            updateChatTitle();
        }

        const prompt = buildPrompt(userMsg);
        if (prompt.length > settings.maxPromptLength) {
            renderSystemMessage(`\u26a0\ufe0f 上下文较长 (${prompt.length}字符)，建议手动总结`);
        }

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
                const retryBtn = aiContent.querySelector('.msg-retry-btn');
                if (retryBtn) {
                    retryBtn.addEventListener('click', () => {
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
            cleanupOldDOMNodes();
        }
    }

    function stopGeneration() { if (abortController) abortController.abort(); }

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
        if (idx < 0) { closeEditDialog(); return; }
        contextMenuTarget.content = newContent;
        contextMenuTarget.timestamp = Date.now();
        msgs.splice(idx + 1);
        closeEditDialog();
        rebuildMessagesUI();
        sendMessage(newContent);
    }

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
        if (!query.trim()) { msgSearchCount.textContent = ''; return; }
        const q = query.toLowerCase();
        const rows = messagesContainer.querySelectorAll('.msg-row');
        rows.forEach(row => {
            const bubble = row.querySelector('.bubble-content');
            if (!bubble) return;
            const text = bubble.textContent.toLowerCase();
            if (text.includes(q)) { msgSearchMatches.push(row); }
        });
        msgSearchCount.textContent = msgSearchMatches.length > 0
            ? `1/${msgSearchMatches.length}` : '无匹配';
        if (msgSearchMatches.length > 0) {
            msgSearchIndex = 0;
            highlightCurrentMatch();
        }
    }

    function navigateMsgSearch(direction) {
        if (msgSearchMatches.length === 0) return;
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
        setTimeout(() => row.classList.remove('msg-highlight'), 600);
    }

    function clearMsgSearchHighlights() {
        messagesContainer.querySelectorAll('.msg-highlight').forEach(el => {
            el.classList.remove('msg-highlight');
        });
    }

    function showContextMenu(x, y, msg, rowEl) {
        contextMenuTarget = msg;
        const userOnly = contextMenu.querySelectorAll('.ctx-item-user-only');
        const aiOnly = contextMenu.querySelectorAll('.ctx-item-ai-only');
        userOnly.forEach(el => el.style.display = msg.role === 'user' ? 'flex' : 'none');
        aiOnly.forEach(el => el.style.display = msg.role === 'assistant' ? 'flex' : 'none');
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
        contextMenu.classList.add('active');
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
                const txt = msg.content;
                navigator.clipboard.writeText(filterAd(txt)).then(() => {
                    showToast('已复制到剪贴板', 'success', 1500);
                }).catch(() => showToast('复制失败', 'error'));
                break;
            }
            case 'edit': { showEditDialog(msg); break; }
            case 'regenerate': { regenerateMessage(msg); break; }
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

    function updateNetworkStatus() {
        if (networkStatus) {
            networkStatus.classList.toggle('visible', !isOnline);
        }
    }

    async function manualSummary() {
        if (isGenerating) return;
        const conv = currentConv();
        if (!conv || (conv.messages.length === 0 && !conv.summary)) {
            showToast('当前没有对话可总结', 'warning');
            return;
        }
        if (!confirm('将总结当前全部对话并清空历史，之后对话会基于摘要继续。确定吗？')) return;

        let conversationText = '';
        if (conv.summary && conv.summary.trim()) {
            conversationText += `[现有摘要]\n${conv.summary}\n\n[新增对话]\n`;
        }
        for (const m of conv.messages) {
            conversationText += (m.role === 'user' ? 'User: ' : 'AI: ') + m.content + '\n';
        }

        const summarizePrompt = `请你作为对话记忆助手，将以下对话内容总结为一份结构清晰、信息完整的摘要。摘要需包含：
1. 用户的核心需求或讨论主题。
2. 对话中的关键事实、决定或结论。
3. 任何需要记住的细节或偏好。
请使用自然段落描述，确保摘要足以让后续对话无缝衔接，不丢失重要信息。不要添加额外评论，直接输出摘要内容。

对话内容：
${conversationText}

摘要：`;

        renderSystemMessage('\ud83d\udcdd 正在生成对话摘要...');
        isGenerating = true;
        updateInputState();

        try {
            const resp = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: summarizePrompt }),
            });
            if (!resp.ok) throw new Error('总结请求失败');
            const reader = resp.body.getReader();
            let text = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                text += new TextDecoder().decode(value);
            }
            const finalSummary = filterAd(text.trim());
            conv.summary = finalSummary;
            conv.messages = [];
            clearMessagesUI();
            renderSystemMessage('\ud83d\udce6 对话已总结，记忆已重置');
            renderSystemMessage(`"${finalSummary.slice(0, 100)}${finalSummary.length > 100 ? '...' : ''}"`);
            saveAll();
            updateContextUsage();
            updateStats();
            showToast('对话总结完成', 'success');
        } catch (e) {
            console.error('总结失败', e);
            renderSystemMessage('\u26a0\ufe0f 总结失败，请重试');
        } finally {
            isGenerating = false;
            updateInputState();
        }
    }

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
            if (getSummary()) renderSystemMessage(`\ud83d\udce6 历史摘要：${getSummary().slice(0, 80)}...`);
            msgs.forEach(m => renderMessage(m, false, true));
            scrollToBottom(true);
        }
        updateContextUsage();
    }

    function updateChatTitle() {
        const conv = currentConv();
        chatTitle.textContent = conv ? conv.title : '新对话';
    }

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
        const len = buildPrompt('').length;
        const pct = Math.min(100, Math.round((len / settings.maxPromptLength) * 100));
        el.textContent = `上下文用量：${len}/${settings.maxPromptLength} 字符 (${pct}%)`;
        el.className = pct > 80 ? 'context-usage warning' : 'context-usage';
    }

    function updateCharCount() {
        const len = chatInput.value.length;
        charCount.textContent = len > 0 ? len : '';
        charCount.className = 'char-count';
        if (len > 800) charCount.classList.add('warning');
        if (len > 1500) charCount.classList.add('danger');
    }

    function openSidebar() {
        sidebar.classList.add('open');
        sidebarOverlay.classList.add('active');
    }

    function closeSidebar() {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
    }

    function openSettings() {
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
        $('#set-maxlen').value = settings.maxPromptLength;
        $('#set-rounds').value = settings.recentRounds;
        $('#blur-val').textContent = settings.backgroundBlur;
        $('#opacity-val').textContent = Math.round(settings.backgroundOpacity * 100);
        updateContextUsage();
    }

    function closeSettings() {
        settings.colorScheme = $('#set-theme').value;
        settings.bubbleStyle = $('#set-bubble').value;
        settings.showTimestamp = $('#set-timestamp').checked;
        settings.backgroundBlur = parseFloat($('#set-blur').value) || 0;
        settings.backgroundOpacity = parseFloat($('#set-opacity').value) || 0.85;
        settings.maxPromptLength = parseInt($('#set-maxlen').value) || 3000;
        settings.recentRounds = parseInt($('#set-rounds').value) || 8;
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

    function autoResizeInput() {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
    }

    function bindEvents() {
        sendBtn.addEventListener('click', () => sendMessage());
        stopBtn.addEventListener('click', stopGeneration);

        chatInput.addEventListener('input', () => {
            autoResizeInput();
            updateCharCount();
            updateSendButtonState();
        });
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

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

        charCount.addEventListener('click', () => {
            const len = chatInput.value.length;
            const tokens = estimateTokens(chatInput.value);
            showToast(`字符: ${len} | 预估 tokens: ~${tokens}`, 'info', 2000);
        });

        $$('.hint-card').forEach(card => {
            card.addEventListener('click', () => {
                const hint = card.getAttribute('data-hint');
                if (hint) sendMessage(hint);
            });
        });

        messagesContainer.addEventListener('scroll', () => { updateScrollButton(); });

        scrollBottomBtn.addEventListener('click', () => {
            scrollToBottom(true);
            userScrolledUp = false;
        });

        $('#menu-btn').addEventListener('click', openSidebar);
        sidebarOverlay.addEventListener('click', closeSidebar);
        $('#new-chat-btn').addEventListener('click', () => {
            createConversation('新对话');
            closeSidebar();
        });

        chatSearch.addEventListener('input', (e) => {
            searchQuery = e.target.value.trim();
            renderChatList();
        });

        $('#summary-btn').addEventListener('click', manualSummary);
        $('#fullscreen-btn').addEventListener('click', toggleFullscreen);
        $('#export-btn-top').addEventListener('click', exportConversation);

        $('#search-msg-btn').addEventListener('click', () => toggleMsgSearch(true));
        $('#msg-search-close').addEventListener('click', () => toggleMsgSearch(false));
        msgSearchInput.addEventListener('input', (e) => { performMsgSearch(e.target.value); });
        msgSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { navigateMsgSearch(e.shiftKey ? -1 : 1); }
            if (e.key === 'Escape') { toggleMsgSearch(false); }
        });
        $('#msg-search-prev').addEventListener('click', () => navigateMsgSearch(-1));
        $('#msg-search-next').addEventListener('click', () => navigateMsgSearch(1));

        $('#sidebar-settings-btn').addEventListener('click', () => { openSettings(); closeSidebar(); });
        settingsOverlay.addEventListener('click', closeSettings);
        $('#close-settings').addEventListener('click', closeSettings);

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

        $('#export-btn').addEventListener('click', exportConversation);
        $('#clear-conv').addEventListener('click', clearCurrentConversation);
        $('#clear-all').addEventListener('click', clearAllData);

        renameOverlay.addEventListener('click', closeRename);

        editOverlay.addEventListener('click', closeEditDialog);
        $('#close-edit').addEventListener('click', closeEditDialog);
        $('#edit-cancel').addEventListener('click', closeEditDialog);
        $('#edit-confirm').addEventListener('click', confirmEdit);
        editInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                confirmEdit();
            }
            if (e.key === 'Escape') { closeEditDialog(); }
        });

        contextMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.ctx-item');
            if (item) { handleContextAction(item.dataset.action); }
        });

        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) { hideContextMenu(); }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { hideContextMenu(); }
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (settings.colorScheme === 'auto') {
                applyTheme();
                applyBackground();
                applyHighlightTheme();
            }
        });

        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
                e.preventDefault();
                createConversation('新对话');
            }
            if (e.key === 'Escape') {
                if (settingsPanel.classList.contains('active')) closeSettings();
                if (renamePanel.classList.contains('active')) closeRename();
                if (editPanel.classList.contains('active')) closeEditDialog();
                if (msgSearchBar.classList.contains('active')) toggleMsgSearch(false);
                if (sidebar.classList.contains('open')) closeSidebar();
            }
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
                e.preventDefault();
                manualSummary();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                if (document.activeElement !== chatInput && document.activeElement !== msgSearchInput) {
                    e.preventDefault();
                    toggleMsgSearch(true);
                }
            }
        });

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

        window.addEventListener('beforeunload', saveAll);

        if (window.visualViewport) {
            const viewport = window.visualViewport;
            const inputArea = $('#input-area');
            viewport.addEventListener('resize', () => {
                if (document.activeElement === chatInput && viewport.height < window.innerHeight * 0.8) {
                    inputArea.style.paddingBottom = '8px';
                } else {
                    inputArea.style.paddingBottom = '';
                }
            });
        }
    }

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