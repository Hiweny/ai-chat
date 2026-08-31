# AI Chat

一个简洁的纯前端 AI 智能对话应用。

## 特性

- 多轮对话
- 流式响应
- OpenAI 兼容 API 配置
- Markdown 渲染
- 代码高亮
- 主题切换
- 本地保存配置与会话
- 无需独立后端，可直接作为静态网页部署

## 项目结构

```text
ai-chat/
├── index.html
├── css/
├── js/
└── README.md
```

核心页面和逻辑目前仍以原生 HTML / CSS / JavaScript 为主，没有引入 React 等前端框架。

## 使用

下载或克隆仓库后，直接用浏览器打开 `index.html` 即可使用；如果浏览器对本地文件的模块或资源加载有限制，可以使用任意静态 HTTP 服务启动目录。

在设置中配置 AI 服务的 Base URL、API Key 和模型即可开始对话。

## 部署

这是一个静态前端项目，可以直接部署到 GitHub Pages、Vercel、Netlify 等静态托管服务。

## License

MIT License
