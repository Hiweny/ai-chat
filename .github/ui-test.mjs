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
        if (u.includes('/images/generations')) {
            await new Promise(r => setTimeout(r, 1200));
            return new Response(JSON.stringify({ data: [{ b64_json: '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' }] }), { headers: { 'content-type': 'application/json' } });
        }
        if (u.includes('/completions') || u.includes('/chat/')) {
            await new Promise(r => setTimeout(r, 300));
            return new Response(window.__canned, { headers: { 'content-type': 'text/plain;charset=utf-8' } });
        }
        return origFetch(url, opt);
    };
});

const page = await ctx.newPage();
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

// ---------- 3. 设置面板 ----------
await page.click('#settings-top-btn');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, '03-settings-top.jpg'), type: 'jpeg', quality: 72 });
const hasProvider = await page.isVisible('#set-provider');
const hasCtx = await page.isVisible('#set-maxlen');
const warnVal = await page.getAttribute('#set-warn', 'max');
ok('设置面板有聊天服务选择', hasProvider);
ok('设置面板有上下文上限', hasCtx);
ok('提醒阈值改为百分数', warnVal === '95', `max=${warnVal}`);
const order = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('.settings-section .section-title')].map(e => e.textContent.trim());
    return titles;
});
ok('上下文区块在聊天/生图之后、提示词之前',
    order.indexOf('上下文与模式') > order.indexOf('聊天服务') && order.indexOf('上下文与模式') < order.indexOf('系统提示词'),
    JSON.stringify(order));
await page.evaluate(() => { document.querySelector('#settings-panel .settings-body').scrollTop = 99999; });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, '04-settings-bottom.jpg'), type: 'jpeg', quality: 72 });
await page.click('#close-settings');
await page.waitForTimeout(300);

// ---------- 4. 普通模式对话 ----------
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
const aiText = await page.locator('.msg-row.assistant .bubble-content').last().textContent();
ok('普通模式不拆分多消息', !String(aiText).includes('|||'), JSON.stringify(String(aiText).slice(0, 60)));

// 时间戳开关
await page.click('#settings-top-btn');
await page.waitForTimeout(300);
await page.check('#set-timestamp');
await page.click('#close-settings');
await page.waitForTimeout(600);
const meta = await page.evaluate(() => {
    const row = document.querySelector('.msg-row.assistant');
    if (!row) return null;
    const bubble = row.querySelector('.bubble');
    const m = row.querySelector('.msg-meta');
    if (!m) return null;
    const b = bubble.getBoundingClientRect();
    const r = m.getBoundingClientRect();
    return { bubbleBottom: b.bottom, metaTop: r.top, inBubble: bubble.contains(m) };
});
ok('时间戳在气泡外部', meta && meta.inBubble === false, JSON.stringify(meta));
ok('时间戳在气泡下方', meta && meta.metaTop >= meta.bubbleBottom - 2, JSON.stringify(meta));
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
await page.evaluate(() => document.querySelector('#mode-btn').click());
await page.waitForTimeout(300);
const modeLabel = await page.textContent('#mode-label');
ok('模式按钮切到 WA', modeLabel === 'WA', modeLabel);

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
    img: !!r.querySelector('.msg-image'),
    failed: (r.textContent || '').includes('生图失败'),
    text: (r.querySelector('.bubble-content') || {}).textContent || ''
})));
const imgIdx = orderRows.findIndex(r => r.img);
ok('waifu 生成了图片', imgIdx >= 0, JSON.stringify(orderRows.map(r => (r.img ? '[IMG]' : r.text.slice(0, 8)))));
ok('图片插在两条消息之间而不是最下方', imgIdx >= 0 && imgIdx < orderRows.length - 1, `imgIdx=${imgIdx} total=${orderRows.length}`);
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
const convStillExists = await page.locator('.chat-list-item').count();
ok('刷新后对话仍在列表', convStillExists >= 1, `count=${convStillExists}`);

await page.screenshot({ path: path.join(OUT, '09-after-reload.jpg'), type: 'jpeg', quality: 72 });

// ---------- 7. 报错汇总 ----------
const realErrors = errors.filter(e => !/favicon|net::ERR|Failed to load resource/i.test(e));
ok('无 JS 运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
await browser.close();

const fails = results.filter(r => !r.pass);
console.log(`\n合计 ${results.length} 项，失败 ${fails.length} 项`);
process.exit(fails.length ? 1 : 0);
