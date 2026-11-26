/**
 * 闪烁检测：用 CDP screencast 录真实渲染帧，逐帧比较，
 * 找出「大面积突变」——那就是肉眼看到的闪。
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123/';
const OUT = 'flicker-out';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
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
await page.waitForTimeout(1200);

// 切到毛玻璃预设
await page.click('#settings-top-btn');
await page.waitForTimeout(500);
await page.selectOption('#set-bubble', 'ios');
await page.waitForTimeout(200);
await page.click('#close-settings');
await page.waitForTimeout(800);

// 先垫两句历史，让画面不为空
for (let i = 0; i < 2; i++) {
    await page.evaluate((n) => {
        window.__canned = '历史消息 ' + n + ' ||| 历史消息 ' + n + ' 的第二段';
        const el = document.querySelector('#chat-input');
        el.value = '铺垫 ' + n;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, i);
    await page.click('#send-btn');
    await page.waitForTimeout(2600);
}
await page.waitForTimeout(1000);

// ---- 开始录屏 ----
const cdp = await ctx.newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
    frames.push({ data, t: metadata.timestamp });
    try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch { }
});

async function record(label, action, ms = 3000) {
    const start = frames.length;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 78, everyNthFrame: 1, maxWidth: 390, maxHeight: 844 });
    await page.waitForTimeout(120);
    const t0 = Date.now();
    await action();
    await page.waitForTimeout(ms);
    try { await cdp.send('Page.stopScreencast'); } catch { }
    const slice = frames.slice(start);
    const dir = path.join(OUT, label);
    fs.mkdirSync(dir, { recursive: true });
    slice.forEach((f, i) => fs.writeFileSync(path.join(dir, String(i).padStart(4, '0') + '.jpg'), Buffer.from(f.data, 'base64')));
    console.log(`${label}: ${slice.length} frames, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return slice.length;
}

// 场景 A：发一条用户消息（waifu 模式会有多条 AI 气泡）
await page.evaluate(() => { window.__canned = '好呀 ||| 我这就去准备 ||| 你稍等一下哦'; });
await record('send', async () => {
    await page.evaluate(() => {
        const el = document.querySelector('#chat-input');
        el.value = '闪烁测试';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#send-btn');
}, 5000);

// 场景 B：只管滚动（快速上翻）
await record('scroll', async () => {
    await page.evaluate(() => {
        const c = document.querySelector('.messages-container');
        let y = c.scrollTop;
        let n = 0;
        const step = () => {
            y -= 90; n++;
            c.scrollTop = Math.max(0, y);
            if (n < 30) requestAnimationFrame(step);
        };
        step();
    });
}, 1500);

await browser.close();

// ---- 分析 ----
const py = `
import sys, glob, os
from PIL import Image, ImageChops, ImageStat
d = sys.argv[1]
summary = {}
for label in sorted(os.listdir(d)):
    p = os.path.join(d, label)
    if not os.path.isdir(p): continue
    files = sorted(glob.glob(os.path.join(p, '*.jpg')))
    if len(files) < 3: 
        summary[label] = {'frames': len(files)}
        continue
    prev = None; diffs = []
    for f in files:
        im = Image.open(f).convert('L').resize((97, 210))
        if prev is not None:
            st = ImageStat.Stat(ImageChops.difference(im, prev))
            diffs.append(round(st.mean[0], 2))
        prev = im
    s = sorted(diffs)
    med = s[len(s)//2] if s else 0
    mx = max(diffs) if diffs else 0
    spikes = [i for i, x in enumerate(diffs) if x > max(6, med * 4)]
    summary[label] = {'frames': len(files), 'median': med, 'max': mx, 'spikes': len(spikes), 'spikeIdx': spikes[:10], 'diffs': diffs}
print(__import__('json').dumps(summary))
`;
fs.writeFileSync(path.join(OUT, 'analyze.py'), py);
const { execFileSync } = await import('child_process');
let out = '';
try {
    out = execFileSync('python3', [path.join(OUT, 'analyze.py'), OUT], { encoding: 'utf8' });
} catch (e) {
    console.log('analyze failed (pillow?)', String(e).slice(0, 200));
}
console.log(out);

let parsed = {};
try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { }

const results = [];
const ok = (name, cond, extra = '') => {
    results.push({ name, pass: !!cond, extra });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};

for (const [label, v] of Object.entries(parsed)) {
    if (!v.diffs) continue;
    ok(`${label}：无大面积突变（闪烁）`, v.spikes === 0, `frames=${v.frames} med=${v.median} max=${v.max} spikes=${v.spikes}@${JSON.stringify(v.spikeIdx)}`);
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
const fails = results.filter(r => !r.pass);
console.log(`\n合计 ${results.length} 项，失败 ${fails.length} 项`);
process.exit(fails.length ? 1 : 0);
