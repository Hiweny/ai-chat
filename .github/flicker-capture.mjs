/**
 * 闪烁检测 v2
 * 闪的特征是「异常帧」：某一帧与前后两帧都差很多，但前后两帧彼此很像。
 * 正常的内容出现/滚动是单向变化，不会回到原样。
 * 同时对三种实现做 A/B：纹理 fixed / 纹理 scroll / 纯色玻璃。
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123/';
const OUT = 'flicker-out';
fs.mkdirSync(OUT, { recursive: true });

const variants = [
    { key: 'texture-fixed', css: '' },
    { key: 'texture-scroll', css: '.bubble{background-attachment:scroll,scroll!important}' },
    { key: 'solid-glass', css: ':root{--glass-tex:none!important}' },
];

const browser = await chromium.launch();

for (const v of variants) {
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        locale: 'zh-CN',
        userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 EdgA/120',
    });
    await ctx.addInitScript(() => {
        window.__canned = '第一条消息 ||| 第二条消息 ||| 第三条消息';
        const origFetch = window.fetch;
        window.fetch = async (url, opt) => {
            const u = String(url);
            if (u.includes('/images/generations')) {
                await new Promise(r => setTimeout(r, 800));
                return new Response(JSON.stringify({ data: [{ b64_json: '' }] }));
            }
            if (u.includes('/completions') || u.includes('/chat/')) {
                await new Promise(r => setTimeout(r, 250));
                return new Response(window.__canned, { headers: { 'content-type': 'text/plain;charset=utf-8' } });
            }
            return origFetch(url, opt);
        };
    });

    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    await page.click('#settings-top-btn');
    await page.waitForTimeout(400);
    await page.selectOption('#set-bubble', 'ios');
    await page.waitForTimeout(150);
    await page.click('#close-settings');
    await page.waitForTimeout(700);

    if (v.css) await page.addStyleTag({ content: v.css });

    for (let i = 0; i < 2; i++) {
        await page.evaluate((n) => {
            window.__canned = '历史 ' + n + ' ||| 历史 ' + n + ' 第二段';
            const el = document.querySelector('#chat-input');
            el.value = '铺垫 ' + n;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }, i);
        await page.click('#send-btn');
        await page.waitForTimeout(2500);
    }
    await page.waitForTimeout(900);

    const cdp = await ctx.newCDPSession(page);
    const frames = [];
    cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
        frames.push(data);
        try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch { }
    });

    const start = frames.length;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1, maxWidth: 390, maxHeight: 844 });
    await page.waitForTimeout(150);
    await page.evaluate(() => { window.__canned = '好呀 ||| 我这就去准备 ||| 你稍等'; });
    await page.evaluate(() => {
        const el = document.querySelector('#chat-input');
        el.value = '闪烁测试';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#send-btn');
    await page.waitForTimeout(5200);
    try { await cdp.send('Page.stopScreencast'); } catch { }

    const slice = frames.slice(start);
    const dir = path.join(OUT, v.key);
    fs.mkdirSync(dir, { recursive: true });
    slice.forEach((f, i) => fs.writeFileSync(path.join(dir, String(i).padStart(4, '0') + '.jpg'), Buffer.from(f.data, 'base64')));
    console.log(`${v.key}: ${slice.length} frames`);

    await ctx.close();
}

await browser.close();
