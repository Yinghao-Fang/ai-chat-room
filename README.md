# AI Chat Room · 沉浸式英语聊天室

一个前后端完整的沉浸式英语听说训练项目：多个 AI 角色在房间里用英文自主聊天并朗读，
实时显示英文字幕与中文翻译，你可以随时插话，让英语环境"泡"着你，而不是靠一问一答。

> 全栈英语沉浸式 AI 聊天室：Node + TypeScript 服务端调度多名 AI 角色自由英文对话，
> 接入 DeepSeek 流式生成；浏览器端实现语音朗读、按住说话识别与中文翻译字幕，
> 对话持久化存储，关闭页面即停止、不浪费 token。

## 功能特性

- **自主对话**：多名 AI 角色轮流用英文聊天，话题自动流转；无人时引擎待机、不产生调用
- **随时插话**：支持键盘输入，也可按住说话用语音提问，AI 会优先回应你
- **语音朗读**：AI 每句话自动朗读（浏览器内置英文语音，Edge/Chrome 效果最佳），
  说完一句才出下一句，字幕与语音同步推进
- **中文翻译**：每条英文字幕右侧附实时中文翻译框（DeepSeek 后台翻译并持久化）
- **字幕/语音开关**：Voice、Mute 可随时切换，纯看字幕也支持
- **持久化**：房间与消息历史存入 SQLite，刷新页面不丢失（API Key 仅存于浏览器内存与
  localStorage，绝不落库）

## 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node.js ≥ 23、TypeScript、Fastify、Socket.IO、内置 `node:sqlite` |
| LLM | DeepSeek（OpenAI 兼容流式接口，模型与地址可在建房页自定义） |
| 前端 | React + TypeScript + Vite，Web Speech API（TTS / ASR） |

## 快速开始（本地开发）

需要 **Node.js ≥ 23.4**（`node:sqlite` 需要）。

```bash
npm install
npm run dev
```

`npm run dev` 会同时启动：
- Web（Vite Dev Server）→ 打开终端提示的地址（默认 http://localhost:5173；
  若 5173 已被其他程序占用，Vite 会自动改用 5174/5175…，请以终端输出为准）
- 后端（Fastify + Socket.IO）→ http://127.0.0.1:8787

打开页面后：填入你的 **DeepSeek API Key** → 创建房间 → 开始沉浸。

> API Key 只在你浏览器与后端内存之间传递，用于本次房间的模型调用，
> 不写入数据库，也不会出现在任何聊天记录里。

## 生产运行（自托管）

```bash
npm run build     # 构建前端 + 后端类型检查
npm start         # Fastify 托管页面与 API（默认 http://127.0.0.1:8787）
```

## 目录结构

```
.
├─ server/            # 后端（ESM + TypeScript）
│  └─ src/
│     ├─ index.ts     # Fastify 入口：REST / 静态托管 / Socket.IO
│     ├─ engine.ts    # ChatEngine：自主对话调度、语音节奏、插话响应
│     ├─ sockets.ts   # Socket 事件 <-> 引擎桥接
│     ├─ db.ts        # node:sqlite 持久化（rooms / messages）
│     ├─ llm.ts       # DeepSeek 流式对话封装
│     └─ personas.ts  # 预制 AI 角色与话题池
├─ web/               # 前端（React + Vite）
│  └─ src/
│     ├─ screens/     # KeyGate（密钥） / Lobby（建房） / Room（聊天室）
│     ├─ tts.ts       # 朗读队列（一句话读完再接下一句）
│     ├─ asr.ts       # 按住说话识别
│     └─ socket.ts    # Socket 事件类型与封装
└─ scripts/smoke.mjs  # Socket 流程冒烟脚本
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 后端监听端口 |
| `HOST` | `127.0.0.1` | 后端监听地址 |

## 使用提示

- 语音朗读与识别依赖浏览器内置能力，**建议使用 Edge 或 Chrome**；
- 想停一会儿不被打扰，可暂停房间；关闭页面后 AI 停止、不消耗 token；
- DeepSeek 需在 [platform.deepseek.com](https://platform.deepseek.com) 开通并充值。
