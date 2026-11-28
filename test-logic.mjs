import fs from 'fs';
import vm from 'vm';

function makeEl(id = '') {
    const el = {
        id, tagName: 'DIV', children: [], dataset: {},
        style: { setProperty() { }, removeProperty() { } },
        _value: '', _checked: false, _text: '', _html: '', disabled: false, open: true, hidden: false,
        classList: { _s: new Set(), add(...c) { c.forEach(x => this._s.add(x)); }, remove(...c) { c.forEach(x => this._s.delete(x)); }, toggle(c, f) { const on = f === undefined ? !this._s.has(c) : f; on ? this._s.add(c) : this._s.delete(c); return on; }, contains(c) { return this._s.has(c); } },
        addEventListener() { }, removeEventListener() { },
        appendChild(c) { this.children.push(c); return c; },
        insertBefore(c) { this.children.unshift(c); return c; },
        removeChild(c) { this.children = this.children.filter(x => x !== c); },
        remove() { }, querySelector() { return makeEl(); }, querySelectorAll() { return []; },
        closest() { return null; }, focus() { }, click() { }, scrollIntoView() { },
        getBoundingClientRect() { return { top: 0, left: 0, width: 300, height: 40, right: 300, bottom: 40 }; },
        setAttribute() { }, getAttribute() { return null; },
        set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
        set textContent(v) { this._text = v; }, get textContent() { return this._text; },
        set value(v) { this._value = v; }, get value() { return this._value; },
        set checked(v) { this._checked = v; }, get checked() { return this._checked; },
        scrollHeight: 100, scrollTop: 0, clientHeight: 100, offsetHeight: 100,
    };
    return el;
}

const elCache = new Map();
const doc = {
    readyState: 'complete',
    documentElement: Object.assign(makeEl('html'), { style: { setProperty() { }, removeProperty() { } } }),
    body: makeEl('body'), activeElement: null, hidden: false, title: '',
    querySelector(sel) { if (!elCache.has(sel)) elCache.set(sel, makeEl(sel)); return elCache.get(sel); },
    querySelectorAll() { return []; },
    createElement(t) { const e = makeEl(); e.tagName = t.toUpperCase(); return e; },
    createTextNode(t) { return { text: t }; },
    addEventListener() { }, removeEventListener() { },
};

const store = new Map();
const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear() };

const win = {
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
    addEventListener() { }, removeEventListener() { },
    matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
    localStorage,
    navigator: { onLine: true, clipboard: { writeText: async () => { } } },
    performance: { now: () => Date.now() },
    requestAnimationFrame: cb => setTimeout(cb, 0),
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { href: 'http://localhost/' },
    confirm: () => true, alert() { },
    visualViewport: { height: 844, offsetTop: 0, scale: 1, addEventListener() { } },
    document: doc, console, TextEncoder, TextDecoder, URL, Blob: class { }, AbortController,
    indexedDB: undefined,
};

const ctx = vm.createContext({
    window: win, document: doc, localStorage, navigator: win.navigator, location: win.location,
    performance: win.performance, requestAnimationFrame: win.requestAnimationFrame,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, TextEncoder, TextDecoder, AbortController, URL, JSON, Math, Date, String, Number, Array, Object, Promise, Error, RegExp, parseInt, parseFloat, isNaN, Set, Map,
    showdown: { Converter: class { makeHtml(t) { return t; } } },
    hljs: { highlightElement() { } },
    confirm: () => true, alert: () => { },
    indexedDB: win.indexedDB,
});

let src = fs.readFileSync('/sandbox/workspace/ai-chat/js/app.js', 'utf8');
src = src.replace(/\}\)\(\);\s*$/, `
    window.__TEST__ = { buildPrompt, buildMessages, headBlocks, extractGenimg, splitWaifuMessages,
        settings, conversations, ensureProviders, currentProvider, currentImageProvider,
        setActive: (id) => { activeConvId = id; }, getMessages, MAX_PROMPT_CHARS, waifu, fitPrompt,
        parseSearchCall, stripSearchCall, searchKeyList, PUBLIC_TAVILY_KEYS,
        stripThinkingText, historyMsgs, withEvidence };
})();
`);
vm.runInContext(src, ctx, { filename: 'app.js' });

const T = win.__TEST__;
const R = [];
const ok = (name, cond, extra = '') => R.push([cond ? 'PASS' : 'FAIL', name, extra]);

T.ensureProviders();
// 生图协议需要有 Key 才会注入，这里先给一个测试 Key（后面单独验证无 Key 的情况）
T.settings.imageProviders[0].apiKey = 'test-key';
T.settings.imageProviderId = T.settings.imageProviders[0].id;
T.settings.imageGenEnabled = true;   // 出厂默认是关的，这里显式打开来测协议
ok('默认聊天供应商=免费接口', T.currentProvider().type === 'free' && T.currentProvider().id === 'free');
ok('默认生图供应商=gitee + z-image-turbo',
    T.currentImageProvider().baseUrl.includes('ai.gitee.com') && T.currentImageProvider().model === 'z-image-turbo');

const cid = 'c1';
T.conversations[cid] = { id: cid, title: 't', summary: '', systemPrompt: '', messages: [
    { role: 'user', content: 'U1', timestamp: 1795600000000 }, { role: 'assistant', content: 'A1', timestamp: 1795600060000 },
    { role: 'user', content: 'U2', timestamp: 1795600120000 },
], createdAt: 1, updatedAt: 1 };
T.setActive(cid);

// 时间注入
const p1 = T.buildPrompt('U2');
ok('prompt 含隐性时间', p1.includes('【当前时间】') && /\d{4}年\d{1,2}月\d{1,2}日/.test(p1));
ok('时间提示不挂在嘴边', p1.includes('不要主动报时间'));
ok('时间块包含判断说明', p1.includes('自然用上') || p1.includes('知道'));
ok('时间块在消息之前', p1.indexOf('【当前时间】') < p1.indexOf('User: U1'));

// 系统提示词
T.settings.systemPrompt = '全局角色：猫娘';
let p2 = T.buildPrompt('U2');
ok('全局系统提示词生效', p2.includes('全局角色：猫娘'));
T.conversations[cid].systemPrompt = '本对话：女仆';
p2 = T.buildPrompt('U2');
ok('对话级提示词覆盖全局', p2.includes('本对话：女仆') && !p2.includes('全局角色：猫娘'));
T.conversations[cid].systemPrompt = '';

// 模式协议
T.conversations[cid].mode = 'normal';
ok('普通模式无 waifu 协议', !T.buildPrompt('U2').includes('【聊天方式：像真人一样发消息】'));
T.conversations[cid].mode = 'waifu';
ok('waifu 模式注入协议', T.buildPrompt('U2').includes('|||'));
T.conversations[cid].mode = 'normal';

// 生图协议
ok('默认注入生图协议', T.buildPrompt('U2').includes('genimg'));
ok('生图协议含自画像占位说明', T.buildPrompt('U2').includes('系统设定里的人设'));
T.settings.selfPortrait = 'black hair, white hoodie';
ok('自画像写进协议', T.buildPrompt('U2').includes('black hair, white hoodie'));
T.settings.selfPortrait = '';

// 保留轮数只影响压缩，不影响每次发送的历史
const cid2 = 'c2';
T.conversations[cid2] = { id: cid2, title: 'w', summary: '', messages: [
    { role: 'user', content: 'R1U' }, { role: 'assistant', content: 'R1A1' }, { role: 'assistant', content: 'R1A2' }, { role: 'assistant', content: 'R1A3' },
    { role: 'user', content: 'R2U' }, { role: 'assistant', content: 'R2A1' }, { role: 'assistant', content: 'R2A2' },
    { role: 'user', content: 'R3U' },
], createdAt: 1, updatedAt: 1 };
T.setActive(cid2);
T.settings.recentRounds = 1;   // 压缩保留轮数，不应该影响发送
const pw = T.buildPrompt('R3U');
ok('历史全部发送，不受「保留轮数」影响', pw.includes('R1U') && pw.includes('R1A1') && pw.includes('R2A2'), JSON.stringify(pw.slice(-160)));
ok('本轮消息只出现一次', (pw.match(/R3U/g) || []).length === 1, `count=${(pw.match(/R3U/g) || []).length}`);
T.settings.recentRounds = 10;
T.setActive(cid);

// 重复消息
const cnt = (T.buildPrompt('U2').match(/User: U2/g) || []).length;
ok('本轮用户消息不重复', cnt === 1, `count=${cnt}`);

// 生图开关（没填 Key 时应自动失效）
T.settings.imageProviders = [{ id: 'imgtest', name: 'g', baseUrl: 'x', apiKey: '', model: 'm' }];
T.settings.imageProviderId = 'imgtest';
T.settings.imageGenEnabled = true;
ok('没填生图 Key 时即使开关打开也不注入协议', !T.buildPrompt('U2').includes('genimg'));
T.settings.imageProviders[0].apiKey = 'test-key';
ok('开启生图时有 genimg 协议', T.buildPrompt('U2').includes('genimg'));
T.settings.imageGenEnabled = false;
ok('关闭生图后协议消失', !T.buildPrompt('U2').includes('genimg'));

// 用户发图的那一轮，不能给他生图能力（否则会"让他看图，他给你画一张"）
T.settings.imageGenEnabled = true;
T.settings.imageProviders[0].apiKey = 'test-key';
ok('普通轮次有生图协议', T.buildPrompt('U3').includes('genimg'));
ok('带图轮次 prompt 不含生图协议', !T.buildPrompt('U3', undefined, { noImage: true }).includes('genimg'));
ok('带图轮次 system 也不含生图协议', !String(T.buildMessages('U3', undefined, { noImage: true })[0].content).includes('genimg'));
ok('生图协议里写明看图不要画图', T.buildPrompt('U3').includes('不要生图'));
T.settings.imageGenEnabled = false;
T.settings.imageGenEnabled = true;

// 图片消息参与上下文（用画面描述）
T.conversations[cid].messages.push({ role: 'assistant', type: 'image', prompt: 'a girl selfie, sunlight', id: 'img1' });
ok('图片以画面描述进入上下文', T.buildPrompt('U2').includes('画面：a girl selfie'));
T.conversations[cid].messages.pop();

// 联网搜索：标记解析
ok('能解析 @@search@@ 标记', T.parseSearchCall('@@search@@ {"query":"今天金价"} @@end@@') === '今天金价');
ok('非 JSON 也能兜底解析', T.parseSearchCall('@@search@@ 明天天气 @@end@@') === '明天天气');
ok('普通回答不会被误判', T.parseSearchCall('你好呀') === '');
ok('strip 能去掉标记', T.stripSearchCall('@@search@@ {"query":"x"} @@end@@') === '');
ok('strip 保留正常文字', T.stripSearchCall('先说一句 @@search@@ {"query":"x"} @@end@@ 结束').includes('先说一句'));
ok('开启搜索才注入协议', (function () {
    T.settings.searchEnabled = false;
    const a = T.buildPrompt('U2').includes('@@search@@');
    T.settings.searchEnabled = true;
    const b = T.buildPrompt('U2').includes('@@search@@');
    T.settings.searchEnabled = false;
    return a === false && b === true;
})());
ok('公益 Key 列表只有 2 个有效项', T.PUBLIC_TAVILY_KEYS.length === 2, String(T.PUBLIC_TAVILY_KEYS.length));
ok('自有 Key 优先时排第一', (function () {
    T.settings.searchSource = 'own'; T.settings.tavilyKey = 'tvly-own';
    const a = T.searchKeyList()[0] === 'tvly-own';
    T.settings.searchSource = 'public';
    const b = T.searchKeyList().slice(-1)[0] === 'tvly-own';
    T.settings.tavilyKey = '';
    return a && b;
})());

// 模式互不影响
T.conversations['c2'] = { id: 'c2', title: 'w', mode: 'waifu', messages: [{ role: 'user', content: 'hi' }], summary: '', createdAt: 1, updatedAt: 1 };
const pWaifu = T.buildPrompt.call(null, 'x');
T.setActive('c2');
ok('waifu 对话注入聊天节奏协议', T.buildPrompt('x').includes('|||'));
T.setActive(cid);
ok('普通对话不注入该协议', !T.buildPrompt('U2').includes('像真人一样用手机聊天'));

// OpenAI messages
const msgs = T.buildMessages('U2');
ok('messages 首条为 system', msgs[0].role === 'system');
ok('messages 末条为 user 且内容正确', msgs[msgs.length - 1].role === 'user' && msgs[msgs.length - 1].content === 'U2');
ok('messages 历史条数正确', msgs.length === 4, `len=${msgs.length}`);

// genimg 解析
const g1 = T.extractGenimg('好看吗\n<genimg prompt="a girl, selfie, sunlight" />\n嘿嘿');
ok('genimg 双引号解析', g1.prompt === 'a girl, selfie, sunlight' && g1.text.includes('好看吗') && !g1.text.includes('genimg'));
const g2 = T.extractGenimg("<genimg prompt='a cat'/>");
ok('genimg 单引号解析', g2.prompt === 'a cat');
const g3 = T.extractGenimg('没有标签的普通回复');
ok('无标签时返回原文', g3.prompt === '' && g3.text === '没有标签的普通回复');

// 多消息分割
const s1 = T.splitWaifuMessages('刚下课 ||| 好累啊 ||| 你在干嘛');
ok('||| 分割成 3 条', s1.length === 3 && s1[1] === '好累啊', JSON.stringify(s1));
const s2 = T.splitWaifuMessages('只有一条消息');
ok('单条不拆分', s2.length === 1);
const s3 = T.splitWaifuMessages('句子一\n\n句子二\n\n句子三');
ok('无分隔符时按空行兜底', s3.length === 3, JSON.stringify(s3));
const s4 = T.splitWaifuMessages('a || b');
ok('双竖线也识别', s4.length === 2);

// 打断 remainder
T.conversations[cid].mode = 'waifu';
T.waifu.remainder = '我还没说完的话';
ok('打断说明进入 prompt', T.buildPrompt('U2').includes('我还没说完的话'));
T.waifu.remainder = '';
T.conversations[cid].mode = 'normal';

// 识图：图片描述必须作为「本轮用户消息」进入 prompt（曾经只存进 msg.ctx，本轮 prompt 里没有）
{
    const cidImg = 'cimg';
    T.conversations[cidImg] = { id: cidImg, title: 'i', summary: '', messages: [], createdAt: 1, updatedAt: 1 };
    T.setActive(cidImg);
    const ctxText = '这张图是什么\n\n【图片内容】\n画面中央是一个红色圆形';
    const m = { role: 'user', content: '这张图是什么', ctx: ctxText, timestamp: 1, id: 'mimg' };
    T.conversations[cidImg].messages.push(m);
    const pImg = T.buildPrompt(ctxText);
    ok('图片描述进入本轮 prompt', pImg.includes('【图片内容】') && pImg.includes('红色圆形'));
    ok('图片描述不以展示文本代替', !/User: 这张图是什么\nAssistant:/.test(pImg));
}

// 搜索协议只注入给免费接口，OpenAI 兼容走原生 tools
{
    T.settings.searchEnabled = true;
    T.settings.providers = [{ id: 'free', name: 'f', type: 'free', baseUrl: 'x', apiKey: '', model: '' }];
    T.settings.chatProviderId = 'free';
    ok('免费接口注入文本搜索协议', T.buildPrompt('U').includes('@@search@@'));
    T.settings.providers.push({ id: 'oa', name: 'o', type: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' });
    T.settings.chatProviderId = 'oa';
    ok('OpenAI 兼容接口不注入文本协议（改走原生 tools）', !T.buildPrompt('U').includes('@@search@@'));
    T.settings.searchEnabled = false;
}

if (process.env.DUMP_PROMPT) {
    T.settings.searchEnabled = true;
    T.settings.imageGenEnabled = true;
    T.conversations['dump'] = { id: 'dump', title: 'd', summary: '早期聊了考试和天气', messages: [
        { role: 'user', content: '我明天考试' }, { role: 'assistant', content: '加油' }, { role: 'user', content: '好紧张' }
    ], mode: 'normal', createdAt: 1, updatedAt: 1 };
    T.setActive('dump');
    console.log('=====PROMPT=====');
    console.log(T.buildPrompt('帮我复习'));
    console.log('=====END=====');
}
// 识图：只取正文，思考内容必须丢掉
ok('识图剥离 <thinking> 块', T.stripThinkingText('<thinking>先分析一下</thinking>一只橘猫趴在窗台') === '一只橘猫趴在窗台', T.stripThinkingText('<thinking>先分析一下</thinking>一只橘猫趴在窗台'));
ok('识图剥离思考前缀', T.stripThinkingText('思考过程：先看主体。\n一只橘猫') === '先看主体。\n一只橘猫', JSON.stringify(T.stripThinkingText('思考过程：先看主体。\n一只橘猫')));

// 提示词结构分段
const pStruct = T.buildPrompt('你好');
ok('prompt 有【本轮】段', pStruct.includes('【本轮】\nUser: 你好'), JSON.stringify(pStruct.slice(-80)));
ok('prompt 不再有旧版格式说明段', !pStruct.includes('【格式说明】'));
ok('带图本轮提示"刚刚发来"', T.buildPrompt('看图', undefined, { hasImages: true }).includes('刚刚'));

console.log('\n============ 结果 ============');
for (const [st, n, e] of R) console.log(`${st}  ${n}${e ? '  (' + e + ')' : ''}`);
const fails = R.filter(r => r[0] === 'FAIL').length;
console.log(`\n合计 ${R.length} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);

