# pi video-summary

本地优先的视频总结扩展：给一个**本地视频路径**或 **B 站 / YouTube 链接**，自动生成一份**图文并茂的 HTML 总结报告**。

## 安装（一行命令）

作为 pi 包直接从 GitHub 安装（克隆 + 自动运行依赖安装器，一条命令全搞定）：

```bash
pi install git:github.com/Ann5t/pi-video-summary-locally
```

`pi install` 克隆仓库后会自动执行 `npm install`，其 `postinstall` 钩子会调用 `install.sh` 完成：ffmpeg、python venv、faster-whisper（有 N 卡自动装 cuBLAS/cuDNN CUDA 加速）、yt-dlp（最新）、预下载 whisper 模型、生成初始配置。幂等，可重复执行。

手动安装（不走 pi 包）：

```bash
git clone https://github.com/Ann5t/pi-video-summary-locally.git ~/.pi/agent/extensions/video-summary && bash ~/.pi/agent/extensions/video-summary/install.sh
```

> ⚠️ **二选一**：如果已经用 `pi install` 装了包，就不要再在 `~/.pi/agent/extensions/` 保留手动拷贝——两处同时存在会因工具重名导致 pi 启动报错（`Tool "video_summary" conflicts...`）。迁移时先删掉手动拷贝再 `pi install`。

## 数据目录（pi update 安全）

所有可变状态都在仓库之外，位于 `${XDG_DATA_HOME:-~/.local/share}/pi-video-summary/`：

- `.venv/` — python 环境（faster-whisper、yt-dlp）
- `models/` — whisper 模型缓存
- `config.json` — 用户配置
- `dictionary.json` — AI 校对自动学习的纠错词典

因此 `pi update --extensions` 重新克隆仓库也不会丢失词典/配置/模型；更新后 `postinstall` 会自动补齐运行环境。

更新与卸载：`pi update --extension git:github.com/Ann5t/pi-video-summary-locally` / `pi remove git:github.com/Ann5t/pi-video-summary-locally`。

## 流程

| 步骤 | 实现 | 花费 |
| ------ | ------ | ------ |
| 获取视频 | 本地路径直接用；URL 用 yt-dlp 下载（≤1080p） | 免费 |
| 音频提取 | ffmpeg → 16kHz mono wav | 免费 |
| 转录 | faster-whisper，CUDA 加速（自动降级 CPU），词级时间戳 | 免费·本地 |
| AI 校对 | 当前 pi 模型挑错（同音字/术语/品牌），修正对自动存入本地词典 `dictionary.json`，下次转录自动应用 + 作为 whisper initial_prompt | 唯一付费点 |
| 画面理解 | 每 N 秒抽帧 → 当前模型（需支持图像输入）描述场景/屏幕文字 | 唯一付费点 |
| 结构化总结 | 当前模型输出 JSON：标题、TL;DR、章节（含时间戳）、要点、金句、配图时间点 | 唯一付费点 |
| 精确取帧 | 按总结标注的时间戳用 ffmpeg `-ss` 精确截取高清帧（非预采样帧） | 免费 |
| HTML 报告 | 自包含单文件：base64 内嵌图片、章节导航、可折叠完整文稿 | 免费 |

## 使用

```
/video-summary /path/to/video.mp4            # 本地文件
/video-summary "https://www.bilibili.com/video/BV..." [--force]
/video-summary "https://www.youtube.com/watch?v=..."
/video-summary-config                        # 所有环节的可配置项
/video-dict                                  # 查看/编辑纠错词典
```

也可以在对话中直接让 pi 总结视频（`video_summary` 工具会被自动调用）。

## 配置（config.json）

配置文件在数据目录 `${XDG_DATA_HOME:-~/.local/share}/pi-video-summary/config.json`（也可在 pi 里用 `/video-summary-config` 直接编辑）。所有默认值见 `lib/config.ts` 的 `DEFAULT_CONFIG`，`config.json` 只需写要覆盖的项：

- `transcribe.model/device/computeType/language/beamSize/vad/batched`
- `vision.enabled/intervalSec/maxFrames/frameWidth/batchSize`
- `proofread.enabled/applyDictionary/learnToDictionary/chunkChars`
- `summary.language/maxTranscriptChars/imagesInReport`
- `frames.reportWidth/jpegQuality`
- `download.maxHeight/format/extraArgs`
- `output.dir/openAfterGenerate`

## 缓存

中间产物缓存在 `~/.cache/pi-video-summary/<hash>/`（音频、转录、vision 笔记、总结 JSON）。
同一个视频重复跑会复用缓存；`--force` 全部重跑。本地视频的 HTML 默认输出到视频旁边
`<名字>.summary.html`；URL 视频输出到缓存目录（可用 `output.dir` 改变）。
