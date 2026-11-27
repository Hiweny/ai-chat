import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123/';
const OUT = 'ui-out';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (name, cond, extra = '') => {
    results.push({ name, pass: !!cond, extra });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const browser = await chromium.launch();
const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 EdgA/120',
});

// 用假的接口和假的 IndexedDB 无关（真实 IDB 可用），只 mock 网络
await ctx.addInitScript(() => {
    window.__canned = '第一条消息 ||| 第二条消息 ||| 第三条消息';
    const origFetch = window.fetch;
    window.fetch = async (url, opt) => {
        const u = String(url);
        // 这些真实接口交给 page.route 处理，不能被 __canned 兜底截走
        if (/openrouter\.ai|api\.test\.local|api\.tavily\.com/.test(u)) return origFetch(url, opt);
        if (u.includes('/images/generations')) {
            await new Promise(r => setTimeout(r, 1200));
            return new Response(JSON.stringify({ data: [{ b64_json: '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' }] }), { headers: { 'content-type': 'application/json' } });
        }
        if (u.includes('/completions') || u.includes('/chat/')) {
            window.__lastChatReq = (opt && opt.body) || '';
            await new Promise(r => setTimeout(r, 300));
            return new Response(window.__canned, { headers: { 'content-type': 'text/plain;charset=utf-8' } });
        }
        return origFetch(url, opt);
    };
});

const page = await ctx.newPage();
async function gotoTab(label) {
    await page.evaluate((l) => {
        const b = [...document.querySelectorAll('.settings-tab')].find(x => x.textContent.trim() === l);
        if (b) b.click();
    }, label);
    await page.waitForTimeout(280);
}

const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// ---------- 1. 首页 ----------
await page.screenshot({ path: path.join(OUT, '01-home.jpg'), type: 'jpeg', quality: 72 });
const welcomeVisible = await page.isVisible('#welcome-screen');
ok('首页显示欢迎屏', welcomeVisible);
const hintCards = await page.locator('.hint-card').count();
ok('首页不再有提示卡片', hintCards === 0, `count=${hintCards}`);
const shortcut = await page.locator('.shortcut-tag').count();
ok('首页不再有快捷键标签', shortcut === 0);

// ---------- 2. 顶栏布局 ----------
const geo = await page.evaluate(() => {
    const L = document.querySelector('.bar-pill-left').getBoundingClientRect();
    const T = document.querySelector('#chat-title').getBoundingClientRect();
    const R = document.querySelector('.bar-pill-right').getBoundingClientRect();
    return { L: { x: L.x, r: L.right, w: L.width }, T: { x: T.x, r: T.right, w: T.width }, R: { x: R.x, r: R.right, w: R.width }, vw: window.innerWidth };
});
ok('标题在左胶囊右侧', geo.T.x >= geo.L.r - 2, JSON.stringify(geo));
ok('标题在右胶囊左侧', geo.T.r <= geo.R.x + 2, JSON.stringify(geo));
ok('左胶囊只包汉堡（宽度 < 60）', geo.L.w < 60, `w=${geo.L.w}`);
ok('标题占满中间空隙', geo.T.w > 60, `w=${geo.T.w}`);
await page.screenshot({ path: path.join(OUT, '02-topbar.jpg'), type: 'jpeg', quality: 72, clip: { x: 0, y: 0, width: 390, height: 80 } });

const avatarCount = await page.locator('.msg-row .avatar').count();
ok('首页没有消息时不渲染头像占位', avatarCount === 0, `count=${avatarCount}`);

// ---------- 3. 设置面板 ----------
await page.click('#settings-top-btn');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, '03-settings-top.jpg'), type: 'jpeg', quality: 72 });
const editorHidden = await page.evaluate(() => {
    const el = document.querySelector('#provider-editor');
    return !el || el.offsetParent === null;
});
ok('服务商编辑表单默认隐藏', editorHidden);
const hasProvider = await page.isVisible('#set-provider');
const hasCtx = await page.isVisible('#set-maxlen');
const warnVal = await page.getAttribute('#set-warn', 'max');
ok('设置面板有聊天服务选择', hasProvider);
ok('设置面板有上下文上限', hasCtx);
ok('提醒阈值改为百分数', warnVal === '95', `max=${warnVal}`);
const ctxInside = await page.evaluate(() => {
    const sections = [...document.querySelectorAll('.settings-section')];
    const chat = sections.find(sec => (sec.querySelector('.section-title') || {}).textContent === '聊天服务');
    if (!chat) return false;
    return !!chat.querySelector('#set-maxlen') && !!chat.querySelector('#set-warn');
});
ok('上下文设置嵌在聊天服务里', ctxInside);

const order = await page.evaluate(() => [...document.querySelectorAll('.settings-section .section-title')].map(e => e.textContent.trim()));
ok('设置分区顺序合理', order[0] === '聊天服务' && order.includes('提示词工程'), JSON.stringify(order));
await page.evaluate(() => { document.querySelector('#settings-panel .settings-body').scrollTop = 99999; });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, '04-settings-bottom.jpg'), type: 'jpeg', quality: 72 });
// 导出备份
const dl = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.evaluate(() => document.querySelector('#export-all').click()),
]).then(r => r[0]);
ok('可以导出备份文件', !!dl, dl ? await dl.suggestedFilename() : 'no download');

await page.click('#close-settings');
await page.waitForTimeout(300);

// ---------- 4. 普通模式对话 ----------
const defaults = await page.evaluate(() => {
    try {
        const m = JSON.parse(localStorage.getItem('aichat_meta_v3') || '{}');
        return {
            mode: (m.settings || {}).defaultMode || '',
            style: (m.settings || {}).bubbleStyle || '',
            imageGen: !!(m.settings || {}).imageGenEnabled,
            avatarCount: [ (m.aiProfile || {}).avatar, (m.userProfile || {}).avatar ].filter(Boolean).length,
        };
    } catch (e) { return {}; }
});
ok('默认对话模式是 waifu', defaults.mode === 'waifu', defaults.mode);
ok('默认气泡样式是现代简约', defaults.style === 'modern', defaults.style);
ok('出厂不预设头像', defaults.avatarCount === 0, String(defaults.avatarCount));
ok('未填生图 Key 时生图默认关闭', defaults.imageGen === false, String(defaults.imageGen));
// 切回 AI 模式做后续测试
for (let i = 0; i < 3; i++) {
    const l = String(await page.textContent('#mode-label') || '').trim();
    if (l === 'AI') break;
    await page.click('#mode-btn');
    await page.waitForTimeout(400);
}
await page.evaluate(() => { window.__canned = '这是普通模式的一条完整回复，不应该被拆开。'; });
await page.evaluate(() => {
    const el = document.querySelector('#chat-input');
    el.value = '你好呀';
    el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#send-btn');
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(OUT, '05-chat-normal.jpg'), type: 'jpeg', quality: 72 });
const msgCount = await page.locator('.msg-row').count();
ok('普通模式生成了一条 AI 回复', msgCount >= 2, `rows=${msgCount}`);
const avatarSrc = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.msg-row .avatar img')].map(i => i.getAttribute('src') || '');
    return imgs;
});
ok('出厂无头像时不渲染头像', avatarSrc.length === 0, JSON.stringify(avatarSrc));
const aiText = await page.locator('.msg-row.assistant .bubble-content').last().textContent();
ok('普通模式不拆分多消息', !String(aiText).includes('|||'), JSON.stringify(String(aiText).slice(0, 60)));

// 时间戳开关
await page.click('#settings-top-btn');
await page.waitForTimeout(300);
await gotoTab('外观');
await page.check('#set-timestamp');
await page.click('#close-settings');
await page.waitForTimeout(400);
await page.waitForSelector('.msg-row.assistant .msg-meta', { timeout: 6000 }).catch(() => { });
await page.waitForTimeout(200);
const meta = await page.evaluate(() => {
    const m = document.querySelector('.msg-meta');
    const diag = {
        metaCount: document.querySelectorAll('.msg-meta').length,
        rowCount: document.querySelectorAll('.msg-row').length,
    };
    if (!m) return { diag };
    const row = m.closest('.msg-row');
    const bubble = row ? row.querySelector('.bubble') : null;
    if (!bubble) return { diag };
    const b = bubble.getBoundingClientRect();
    const r = m.getBoundingClientRect();
    return { diag, bubbleBottom: b.bottom, metaTop: r.top, inBubble: bubble.contains(m) };
});
ok('时间戳在气泡外部', meta.inBubble === false, JSON.stringify(meta));
ok('时间戳在气泡下方', typeof meta.metaTop === 'number' && meta.metaTop >= meta.bubbleBottom - 2, JSON.stringify(meta));
await page.screenshot({ path: path.join(OUT, '06-timestamp.jpg'), type: 'jpeg', quality: 72 });

// ---------- 5. Waifu 模式 ----------
await page.evaluate(() => { localStorage.removeItem('aichat_meta_v3'); });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.evaluate(() => { window.__canned = '第一条消息 ||| 第二条消息 ||| 第三条消息'; });
// 新建一个干净对话再做 waifu 测试
await page.evaluate(() => document.querySelector('#menu-btn').click());
await page.waitForTimeout(500);
await page.evaluate(() => document.querySelector('#new-chat-btn').click());
await page.waitForTimeout(600);
const modeLabel = String(await page.textContent('#mode-label') || '').trim();
ok('新对话默认就是 WA 模式', modeLabel === 'WA', modeLabel);

await page.evaluate(() => {
    const el = document.querySelector('#chat-input');
    el.value = '在吗';
    el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#send-btn');
await page.waitForTimeout(9000);
await page.screenshot({ path: path.join(OUT, '07-waifu.jpg'), type: 'jpeg', quality: 72, fullPage: false });
const wfRows = await page.locator('.msg-row.assistant').count();
ok('waifu 模式拆成多条气泡', wfRows >= 2, `rows=${wfRows}`);
const wfTexts = await page.locator('.msg-row.assistant .bubble-content').allTextContents();
ok('waifu 气泡内容正确', wfTexts.some(t => t.includes('第一条消息')), JSON.stringify(wfTexts));

// ---------- 5.5 waifu 下生图顺序 ----------
await page.evaluate(() => { window.__canned = '给你拍一张 ||| <genimg prompt="a girl taking a selfie, natural light" /> ||| 好看吗'; });
await page.evaluate(() => {
    const el = document.querySelector('#chat-input');
    el.value = '来张自拍';
    el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.evaluate(() => document.querySelector('#send-btn').click());
await page.waitForTimeout(14000);
const orderRows = await page.evaluate(() => [...document.querySelectorAll('.msg-row')].map(r => ({
    img: !!r.querySelector('.image-msg img'),
    failed: (r.textContent || '').includes('生图失败'),
    text: (r.querySelector('.bubble-content') || {}).textContent || ''
})));
const imgIdx = orderRows.findIndex(r => r.img);
ok('waifu 生成了图片', imgIdx >= 0, JSON.stringify(orderRows.map(r => (r.img ? '[IMG]' : r.text.slice(0, 8)))));
ok('图片插在两条消息之间而不是最下方', imgIdx >= 0 && imgIdx < orderRows.length - 1, `imgIdx=${imgIdx} total=${orderRows.length}`);
const emptyBubbles = await page.evaluate(() => [...document.querySelectorAll('.msg-row .bubble-content')]
    .filter(e => !(e.textContent || '').trim() && !e.querySelector('img, canvas')).length);
ok('没有空气泡残留', emptyBubbles === 0, `empty=${emptyBubbles}`);
const imgNoBubble = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.image-msg img')];
    if (!imgs.length) return false;
    return imgs.every(img => !img.closest('.bubble'));
});
ok('图片不包在气泡里', imgNoBubble);
await page.screenshot({ path: path.join(OUT, '07b-waifu-image.jpg'), type: 'jpeg', quality: 72 });

// ---------- 6. 多会话与刷新 ----------
await page.evaluate(() => document.querySelector('#menu-btn').click());
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '08-sidebar.jpg'), type: 'jpeg', quality: 72 });
await page.evaluate(() => document.querySelector('#new-chat-btn').click());
await page.waitForTimeout(500);
const titleAfterNew = await page.textContent('#chat-title');
ok('新建对话标题为「新对话」', String(titleAfterNew).includes('新对话'), titleAfterNew);

// 手动改名 → 发消息 → 名字不应被覆盖
await page.evaluate(() => document.querySelector('#menu-btn').click());
await page.waitForTimeout(600);
await page.evaluate(() => {
    const btn = document.querySelector('.chat-list-item [data-action="rename"]');
    if (btn) btn.click();
});
await page.waitForTimeout(400);
await page.fill('#rename-input', '我的专属对话');
await page.fill('#rename-systemprompt', '你是我的私人助理');
await page.click('#rename-confirm');
await page.waitForTimeout(600);
const titleRenamed = await page.textContent('#chat-title');
ok('改名后标题更新', String(titleRenamed).includes('我的专属对话'), titleRenamed);

await page.evaluate(() => {
    const el = document.querySelector('#chat-input');
    el.value = '第一条消息测试';
    el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#send-btn');
await page.waitForTimeout(6000);
const titleAfterMsg = await page.textContent('#chat-title');
ok('发首条消息不覆盖用户改的名字', String(titleAfterMsg).includes('我的专属对话'), titleAfterMsg);

// 刷新后仍在同一对话
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const titleAfterReload = await page.textContent('#chat-title');
ok('刷新后仍停留在该对话', String(titleAfterReload).includes('我的专属对话'), titleAfterReload);
const actionVisible = await page.evaluate(() => {
    const el = document.querySelector('.chat-list-item .item-actions');
    if (!el) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none';
});
ok('侧栏操作按钮常显', actionVisible);
const convStillExists = await page.locator('.chat-list-item').count();
ok('刷新后对话仍在列表', convStillExists >= 1, `count=${convStillExists}`);

await page.screenshot({ path: path.join(OUT, '09-after-reload.jpg'), type: 'jpeg', quality: 72 });

// ---------- 7. 液态玻璃 & 合成层质量 ----------
// 先切到毛玻璃预设（默认为"现代简约"，不含模糊）
await page.click('#settings-top-btn');
await page.waitForTimeout(500);
await gotoTab('外观');
await page.selectOption('#set-bubble', 'ios');
await page.waitForTimeout(200);
await page.click('#close-settings');
await page.waitForTimeout(600);

for (let i = 0; i < 4; i++) {
    const label = String(await page.textContent('#mode-label') || '').trim();
    if (label === 'AI') break;
    await page.click('#mode-btn');
    await page.waitForTimeout(400);
}

for (let i = 1; i <= 5; i++) {
    await page.evaluate((n) => {
        window.__canned = '这是第 ' + n + ' 条测试回复，用来把对话拉长到一屏以上，方便观察毛玻璃与滚动合成层的表现。';
        const el = document.querySelector('#chat-input');
        el.value = '消息 ' + n;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, i);
    await page.click('#send-btn');
    await page.waitForTimeout(1500);
}
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '10-glass-long.jpg'), type: 'jpeg', quality: 72 });

const glass = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.bubble')];
    const cs = (el) => el ? getComputedStyle(el) : null;
    const withBlur = bubbles.filter(b => /blur\(/.test(cs(b).backdropFilter || ''));
    const withTex = bubbles.filter(b => /data:image/.test(cs(b).backgroundImage || ''));
    const iw = document.querySelector('.input-wrapper');
    const pill = document.querySelector('.bar-pill');
    return {
        total: bubbles.length,
        withBlur: withBlur.length,
        withTex: withTex.length,
        texVar: getComputedStyle(document.documentElement).getPropertyValue('--glass-tex').slice(0, 30),
        input: cs(iw).backdropFilter,
        inputColor: cs(iw).backgroundColor,
        inputTex: /data:image/.test(cs(iw).backgroundImage || ''),
        inputShadow: cs(iw).boxShadow,
        inputRadius: cs(iw).borderRadius,
        pill: cs(pill).backdropFilter,
        pillTex: /data:image/.test(cs(pill).backgroundImage || ''),
        attach: cs(bubbles[bubbles.length - 1]).backgroundAttachment,
        repeat: cs(bubbles[bubbles.length - 1]).backgroundRepeat,
        bgImg: cs(bubbles[bubbles.length - 1]).backgroundImage,
        bgSize: cs(bubbles[bubbles.length - 1]).backgroundSize,
        mode: document.documentElement.getAttribute('data-style'),
    };
});
ok('气泡是纯 CSS 玻璃（不含图片资源）', glass.withTex === 0, `tex=${glass.withTex}/${glass.total}`);
ok('气泡不挂 backdrop-filter（不会降级）', glass.withBlur === 0, `blur=${glass.withBlur}/${glass.total}`);
ok('气泡背景不含图片（不会拼接）', !/url\(/.test(glass.bgImg || ''), String(glass.bgImg).slice(0, 60));
ok('气泡背景不按固定尺寸平铺（不会出现接缝）', !/\d+px/.test(glass.bgSize || ''), glass.bgSize);
ok('主题已同步到根节点', glass.mode === 'ios', glass.mode);
ok('输入框与气泡同一套材质（不使用图片）', glass.inputTex === false);
ok('输入框仍有悬浮高光阴影', glass.inputShadow !== 'none' && glass.inputShadow.length > 20);
ok('输入框圆角足够大', parseFloat(glass.inputRadius) >= 24, glass.inputRadius);
ok('胶囊条与气泡同一套材质（不使用图片）', glass.pillTex === false);

// 水玻璃预设
await page.click('#settings-top-btn');
await page.waitForTimeout(500);
await gotoTab('外观');
await page.selectOption('#set-bubble', 'water');
await page.waitForTimeout(200);
await page.click('#close-settings');
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(OUT, '10b-glass-water.jpg'), type: 'jpeg', quality: 72 });
const water = await page.evaluate(() => {
    const cs = (el) => el ? getComputedStyle(el) : null;
    const b = document.querySelector('.bubble.water.assistant');
    const iw = document.querySelector('.input-wrapper');
    const pill = document.querySelector('.bar-pill');
    return {
        found: !!b,
        color: b ? cs(b).backgroundColor : '',
        tex: b ? /data:image/.test(cs(b).backgroundImage || '') : false,
        blurOn: b ? /blur\(/.test(cs(b).backdropFilter || '') : true,
        inputColor: cs(iw).backgroundColor,
        pillColor: cs(pill).backgroundColor,
        mode: document.documentElement.getAttribute('data-style'),
    };
});
ok('水玻璃气泡是纯 CSS 玻璃（无 backdrop-filter）', water.found && !water.tex && water.blurOn === false, JSON.stringify(water).slice(0, 120));
const alphaOf = (c) => { const m = String(c).match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/); return m ? parseFloat(m[1]) : 1; };
ok('水玻璃比毛玻璃更透', alphaOf(water.color) < 0.45, water.color);
ok('输入框跟随水玻璃样式', alphaOf(water.inputColor) < 0.3, water.inputColor);
ok('胶囊条跟随水玻璃样式', alphaOf(water.pillColor) < 0.3, water.pillColor);
ok('输入框与气泡同属水玻璃主题', /0\.1\d|0\.2/.test(water.inputColor), water.inputColor);
ok('根节点主题已切到 water', water.mode === 'water', water.mode);

// 色带检测：截气泡内部左 padding 的竖条，交给 python 逐行比对
await page.evaluate(() => { const c = document.querySelector('.messages-container'); c.scrollTop = c.scrollHeight; });
await page.waitForTimeout(400);
const tall = await page.evaluate(() => {
    let best = null;
    for (const b of document.querySelectorAll('.bubble.assistant')) {
        const r = b.getBoundingClientRect();
        if (r.height > 40 && r.top > 55 && r.top < window.innerHeight * 0.62 && r.width > 80) {
            if (!best || r.height > best.h) best = { x: r.x, y: r.y, w: r.width, h: r.height };
        }
    }
    return best;
});
if (tall) {
    await page.screenshot({
        path: path.join(OUT, 'bubble-strip.png'),
        clip: { x: Math.round(tall.x + 4), y: Math.round(tall.y + 6), width: 10, height: Math.round(tall.h - 12) },
    });
    ok('截到气泡竖条用于色带检测', true, `h=${Math.round(tall.h)}`);
} else {
    ok('截到气泡竖条用于色带检测', false, 'no tall bubble');
}

// 侧栏
await page.click('#menu-btn');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '11-sidebar-glass.jpg'), type: 'jpeg', quality: 72 });
const side = await page.evaluate(() => {
    const sb = document.querySelector('#sidebar');
    const cs = getComputedStyle(sb);
    const btn = document.querySelector('.chat-list-item .item-action-btn');
    return {
        bgImage: cs.backgroundImage,
        filter: cs.backdropFilter,
        hasOldSettings: !!document.querySelector('#sidebar-settings-btn'),
        hasFooter: !!document.querySelector('.sidebar-footer'),
        iconSvg: !!(btn && btn.querySelector('svg')),
        iconText: btn ? String(btn.textContent || '').trim() : 'NO-BTN',
    };
});
ok('侧栏是磨砂玻璃', /blur\(/.test(side.filter) && /gradient/.test(side.bgImage), side.filter);
ok('侧栏左下角设置按钮已移除', !side.hasOldSettings && !side.hasFooter);
ok('对话操作按钮改线条图标', side.iconSvg === true && side.iconText === '', side.iconText);
await page.evaluate(() => {
    const ov = document.querySelector('#sidebar-overlay');
    if (ov) ov.click();
});
await page.waitForTimeout(400);

// ---------- 7.5 识图 / 联网搜索 ----------
await page.click('#settings-top-btn');
await page.waitForTimeout(500);
const newFeat = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('.settings-section .section-title')].map(e => e.textContent.trim());
    const v = document.querySelector('#set-vision');
    const se = document.querySelector('#set-search');
    return {
        hasVisionSection: titles.includes('识图服务'),
        hasSearchSection: titles.includes('联网搜索'),
        visionChecked: v ? v.checked : null,
        visionDisabled: v ? v.disabled : null,
        searchChecked: se ? se.checked : null,
        hasVisionPrompt: !!document.querySelector('#prompt-vision'),
        hasAttachBtn: !!document.querySelector('#attach-btn'),
    };
});
ok('设置里有识图服务', newFeat.hasVisionSection);
ok('设置里有联网搜索', newFeat.hasSearchSection);
ok('识图默认关闭', newFeat.visionChecked === false, String(newFeat.visionChecked));
ok('未填 Key 时识图开关禁用', newFeat.visionDisabled === true, String(newFeat.visionDisabled));
ok('联网搜索默认关闭', newFeat.searchChecked === false, String(newFeat.searchChecked));
ok('提示词工程里有识图提示词', newFeat.hasVisionPrompt);
ok('输入框有上传图片按钮', newFeat.hasAttachBtn);
await gotoTab('人格');
await page.evaluate(() => { const t = document.querySelector('#prompt-vision'); if (t) t.scrollIntoView({ block: 'center' }); });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, '14-vision-prompt.jpg'), type: 'jpeg', quality: 72 });
await page.click('#close-settings');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, '15-input-attach.jpg'), type: 'jpeg', quality: 72, clip: { x: 0, y: 640, width: 390, height: 204 } });

// ---------- 8. 主题系统 & 设置分区 ----------
await page.click('#settings-top-btn');
await page.waitForTimeout(500);
const tabs = await page.evaluate(() => [...document.querySelectorAll('.settings-tab')].map(b => b.textContent.trim()));
ok('设置面板有顶部分区导航', tabs.length === 5, JSON.stringify(tabs));
await page.evaluate(() => {
    const b = [...document.querySelectorAll('.settings-tab')].find(x => x.textContent.trim() === '外观');
    if (b) b.click();
});
await page.waitForTimeout(350);
const activePane = await page.evaluate(() => {
    const p = document.querySelector('.settings-pane.active');
    return p ? p.dataset.tab : '';
});
ok('点击分区能切到对应内容', activePane === 'look', activePane);
await page.screenshot({ path: path.join(OUT, '12-settings-tabs.jpg'), type: 'jpeg', quality: 72 });

// 切到微信主题
await gotoTab('外观');
await page.selectOption('#set-bubble', 'wechat');
await page.waitForTimeout(200);
await page.click('#close-settings');
await page.waitForTimeout(600);
const wx = await page.evaluate(() => {
    const u = document.querySelector('.bubble.user');
    const a = document.querySelector('.bubble.assistant');
    return {
        style: document.documentElement.getAttribute('data-style'),
        userBg: u ? getComputedStyle(u).backgroundColor : '',
        aiBg: a ? getComputedStyle(a).backgroundColor : '',
        aiBlur: a ? getComputedStyle(a).backdropFilter : '',
    };
});
ok('微信主题已应用', wx.style === 'wechat', wx.style);
ok('微信发送气泡是微信绿', /149,\s*236,\s*105/.test(wx.userBg), wx.userBg);
ok('微信接收气泡是纯白', /255,\s*255,\s*255/.test(wx.aiBg), wx.aiBg);

// 切到 iMessage
await page.click('#settings-top-btn');
await page.waitForTimeout(400);
await gotoTab('外观');
await page.selectOption('#set-bubble', 'imessage');
await page.waitForTimeout(200);
await page.click('#close-settings');
await page.waitForTimeout(500);
const im = await page.evaluate(() => {
    const u = document.querySelector('.bubble.user');
    return { style: document.documentElement.getAttribute('data-style'), bg: u ? getComputedStyle(u).backgroundColor : '' };
});
ok('iMessage 主题已应用', im.style === 'imessage', im.style);
ok('iMessage 气泡是 #007aff', /0,\s*122,\s*255/.test(im.bg), im.bg);
await page.screenshot({ path: path.join(OUT, '13-theme-imessage.jpg'), type: 'jpeg', quality: 72 });

// 回到默认（现代简约）
await page.click('#settings-top-btn');
await page.waitForTimeout(400);
await gotoTab('外观');
await page.selectOption('#set-bubble', 'modern');
await page.waitForTimeout(200);
await page.click('#close-settings');
await page.waitForTimeout(400);

// ---------- 6.6 识图端到端（mock 识图 + 聊天接口，验证真实链路） ----------
// 跨域 mock：浏览器会先发 OPTIONS 预检，必须带上 CORS 头，否则真实 POST 根本不会发出
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
let visionReq = null, chatReq = '';
await page.route('**/*', async route => {
    if (!/openrouter\.ai/.test(route.request().url())) return route.fallback();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    try { visionReq = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    await new Promise(r => setTimeout(r, 900));   // 故意慢一点，验证"先上屏再识图"
    route.fulfill({
        status: 200, headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ choices: [{ message: { content: '画面中央是一个红色圆形，背景是浅蓝色，左上角写着 HELLO 2026。' } }] }),
    });
});
await page.route('**/*', async route => {
    if (!/cnmwx/.test(route.request().url())) return route.fallback();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    chatReq = route.request().postData() || '';
    route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' }, body: '我看到图里有个红色圆形啦。' });
});

// 填识图 Key 并启用
await page.click('#settings-top-btn');
await page.waitForTimeout(500);
await gotoTab('服务');
await page.click('#visionprovider-list .btn-small');
await page.waitForTimeout(300);
await page.fill('#ve-key', 'sk-or-v1-ci-dummy-key');
await page.click('#ve-save');
await page.waitForTimeout(500);
const visionUnlocked = await page.evaluate(() => {
    const v = document.getElementById('set-vision');
    return { disabled: v.disabled, hint: (document.getElementById('vision-hint') || {}).textContent || '' };
});
ok('填 Key 后识图开关可用', visionUnlocked.disabled === false, JSON.stringify(visionUnlocked));
await page.evaluate(() => {
    const v = document.getElementById('set-vision');
    v.checked = true;
    v.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(200);
await page.click('#close-settings');
await page.waitForTimeout(400);

// 选一张图
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR42mNkYPhfz0AEYBxVSF+FjIOuMEYXsjCqkL4KAQAA//8DAAoAAf8E3ZcAAAAASUVORK5CYII=', 'base64');
const fcP = page.waitForEvent('filechooser');
await page.click('#attach-btn');
const fc = await fcP;
await fc.setFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG });
await page.waitForTimeout(800);
ok('选图后出现缩略图预览', await page.evaluate(() => document.querySelectorAll('#attach-preview .attach-item').length > 0));
await page.screenshot({ path: path.join(OUT, '16-attach-preview.jpg'), type: 'jpeg', quality: 72, clip: { x: 0, y: 560, width: 390, height: 284 } });

// 发送：先上屏，再识图
await page.fill('#chat-input', '这张图是什么');
await page.click('#send-btn');
await page.waitForTimeout(300);
const midState = await page.evaluate(() => {
    const hint = document.getElementById('busy-hint');
    return {
        userRows: document.querySelectorAll('.msg-row.user').length,
        hintShown: hint && !hint.hidden,
        hintText: (document.getElementById('busy-hint-text') || {}).textContent || '',
    };
});
ok('识图未完成时消息已先上屏', midState.userRows > 0, String(midState.userRows));
ok('输入框上方显示"正在识图"', midState.hintShown && /识图/.test(midState.hintText), JSON.stringify(midState));
await page.screenshot({ path: path.join(OUT, '17-vision-busy.jpg'), type: 'jpeg', quality: 72 });

await page.waitForTimeout(3200);
if (!visionReq) {
    const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent));
    console.log('   [diag] 识图未发出请求，页面提示：', JSON.stringify(toasts));
}
ok('识图请求带上了图片数据', !!(visionReq && visionReq.messages && Array.isArray(visionReq.messages[0].content)
    && visionReq.messages[0].content.some(c => c.type === 'image_url' && /^data:image\//.test(c.image_url && c.image_url.url))));
ok('识图请求 max_tokens 足够（推理模型）', !!(visionReq && visionReq.max_tokens >= 1200), String(visionReq && visionReq.max_tokens));
ok('识图请求带了提示词', !!(visionReq && visionReq.messages[0].content.some(c => c.type === 'text' && c.text && c.text.length > 10)));
const lastChatReq = await page.evaluate(() => window.__lastChatReq || '');
ok('聊天请求里带上了【图片内容】描述', /【图片内容】/.test(lastChatReq) && /红色圆形/.test(lastChatReq), lastChatReq.slice(0, 200));
ok('识图结束后状态条收起', await page.evaluate(() => document.getElementById('busy-hint').hidden));

// ---------- 6.8 OpenAI 兼容接口：走原生 function calling ----------
const nativeReqs = [];
await page.route('**/*', async route => {
    if (!/api\.test\.local/.test(route.request().url())) return route.fallback();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    nativeReqs.push(body);
    const hasToolMsg = (body.messages || []).some(m => m.role === 'tool');
    if (!hasToolMsg && Array.isArray(body.tools) && body.tools.length) {
        const sse = [
            'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '' } }] } }] }) + '\n\n',
            'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"北京天气"}' } }] } }] }) + '\n\n',
            'data: [DONE]\n\n',
        ].join('');
        await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sse });
        return;
    }
    await route.fulfill({
        status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' },
        body: 'data: ' + JSON.stringify({ choices: [{ delta: { content: '北京今天晴，18 度。' } }] }) + '\n\ndata: [DONE]\n\n',
    });
});
let tavilyHits = 0;
await page.route('**/*', async route => {
    if (!/tavily/.test(route.request().url())) return route.fallback();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    tavilyHits++;
    await route.fulfill({
        status: 200, headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ query: '北京天气', answer: '晴，18度', results: [{ title: '北京天气预报', content: '今天晴，最高 18 度', url: 'https://weather.example/bj' }] }),
    });
});

await page.click('#settings-top-btn');
await page.waitForTimeout(400);
await gotoTab('服务');
await page.click('#provider-add');
await page.waitForTimeout(250);
await page.fill('#pe-name', '测试接口');
await page.fill('#pe-url', 'https://api.test.local/v1');
await page.fill('#pe-key', 'sk-test');
await page.fill('#pe-model', 'test-model');
await page.click('#pe-save');
await page.waitForTimeout(500);
const curProv = await page.evaluate(() => {
    const sel = document.getElementById('set-provider');
    return sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '';
});
ok('已切到 OpenAI 兼容接口', /测试接口/.test(curProv), curProv);

// 开启联网搜索
await page.evaluate(() => {
    const el = document.getElementById('set-search');
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
});
await page.waitForTimeout(200);
await page.click('#close-settings');
await page.waitForTimeout(400);

// 确保普通模式（waifu 模式会延迟合并，影响断言）
await page.click('#settings-top-btn');
await page.waitForTimeout(400);
await gotoTab('对话');
await page.evaluate(() => {
    const el = document.getElementById('set-waifu');
    if (el && el.checked) { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
});
await page.click('#close-settings');
await page.waitForTimeout(400);

await page.fill('#chat-input', '北京今天天气怎么样');
await page.click('#send-btn');
await page.waitForTimeout(6000);

ok('第一轮请求带原生 tools 声明', nativeReqs.length > 0 && Array.isArray(nativeReqs[0].tools)
    && nativeReqs[0].tools[0] && nativeReqs[0].tools[0].function.name === 'web_search',
    JSON.stringify(nativeReqs[0] && nativeReqs[0].tools));
ok('tool_choice = auto（模型自己决定搜不搜）', nativeReqs[0] && nativeReqs[0].tool_choice === 'auto', String(nativeReqs[0] && nativeReqs[0].tool_choice));
ok('Tavily 被真实调用', tavilyHits > 0, String(tavilyHits));
const secondReq = nativeReqs.find(r => (r.messages || []).some(m => m.role === 'tool'));
ok('第二轮把检索结果作为 tool 消息回传', !!secondReq && /天气预报/.test(JSON.stringify(secondReq.messages || [])),
    secondReq ? JSON.stringify(secondReq.messages.slice(-2)).slice(0, 200) : 'no second req');
ok('assistant 消息带 tool_calls', !!secondReq && (secondReq.messages || []).some(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length));
ok('最终回答上屏', await page.evaluate(() => {
    const rows = document.querySelectorAll('.msg-row.assistant .bubble-content');
    return rows.length > 0 && rows[rows.length - 1].textContent.includes('北京今天晴');
}));
await page.screenshot({ path: path.join(OUT, '19-native-tools.jpg'), type: 'jpeg', quality: 72 });

// 关掉搜索后再问，不应带 tools（"不是每条消息都搜"）
await page.click('#settings-top-btn');
await page.waitForTimeout(400);
await page.evaluate(() => {
    const el = document.getElementById('set-search');
    if (el) { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
});
await page.click('#close-settings');
await page.waitForTimeout(300);
nativeReqs.length = 0;
await page.fill('#chat-input', '我们随便聊聊吧');
await page.click('#send-btn');
await page.waitForTimeout(1500);
ok('关闭联网时不带 tools', nativeReqs.length > 0 && !(nativeReqs[0] && nativeReqs[0].tools), JSON.stringify(Object.keys(nativeReqs[0] || {})));

// ---------- 6.7 上下文进度条 ----------
await page.click('#settings-top-btn');
await page.waitForTimeout(500);
await gotoTab('对话');
const meter = await page.evaluate(() => {
    const f = document.getElementById('ctx-meter-fill');
    const box = document.getElementById('ctx-meter');
    return {
        width: f ? f.style.width : '',
        pct: (document.getElementById('ctx-meter-pct') || {}).textContent || '',
        foot: (document.getElementById('ctx-meter-text') || {}).textContent || '',
        visible: !!(f && f.getBoundingClientRect().width > 0),
    };
});
ok('对话分区有上下文进度条', meter.visible, JSON.stringify(meter));
ok('进度条有百分比数字', /\d+%/.test(meter.pct), meter.pct);
ok('进度条有字符数说明', /字符/.test(meter.foot), meter.foot);
await page.screenshot({ path: path.join(OUT, '18-ctx-meter.jpg'), type: 'jpeg', quality: 72 });
await page.click('#close-settings');
await page.waitForTimeout(300);

// ---------- 7. 报错汇总 ----------
const realErrors = errors.filter(e => !/favicon|net::ERR|Failed to load resource/i.test(e));
ok('无 JS 运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
await browser.close();

const fails = results.filter(r => !r.pass);
console.log(`\n合计 ${results.length} 项，失败 ${fails.length} 项`);
process.exit(fails.length ? 1 : 0);
