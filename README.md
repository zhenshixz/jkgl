# 家庭健康管理 - 体检管理第一版

这是家庭自用的体检管理工具，当前覆盖体检套餐、体检规划、体检分析和家人基础信息。

## 当前功能

- 上传医院公众号/小程序套餐详情截图进行 OCR，提取检查内容
- 复制截图后可直接在页面按 Ctrl+V 粘贴
- OCR 主路径使用本地 PaddleOCR 后端服务
- OCR 后进入人工核对表格
- 核对后确认进入套餐库
- 管理套餐价格、适用人群、独立套餐备注、检查项目
- 多套餐横向对比
- 独立管理家庭成员
- 按成员勾选套餐生成体检方案，并用“保留/新增/排除/待确认”标记增减项
- 日常检查按家人、科室和月份维护问诊记录、注意事项及关联报告
- 指标跟踪直接读取统一报告库，按家人、科室和日期管理已确认报告
- 支持粘贴或上传报告图片；文字型 PDF 直接提取，扫描型 PDF 逐页 OCR
- 日常检查上传的报告自动关联当前台账；指标跟踪单独导入的报告不会反向创建日常记录，可按需手动关联
- 业务数据保存到本地后端 `backend/data.json`，浏览器 localStorage 作为兜底缓存
- 连续编辑采用 500ms 防抖并按顺序写入后端，避免深层监听重复提交整份数据
- 后端在线时以后端数据为准；后端不可用时才使用浏览器缓存
- 保存数据前自动保留上一版 `backend/data.backup.json`
- 套餐列表支持单个套餐导出，或勾选多个套餐批量导出为 `.xlsx` 明细表

## 使用方式

第一次使用先安装 OCR 后端依赖：

```bat
install_backend.bat
```

之后每次使用先启动本地 OCR 服务：

```bat
start_backend.bat
```

后端启动后，用浏览器打开：

```text
http://localhost:8765/
```

也可以直接打开 `index.html`，此时页面会调用 `http://localhost:8765` 上的本地后端接口。

默认 OCR 地址是：

```text
http://localhost:8765/api/ocr
```

Vue、Element Plus、SheetJS 已放在项目 `vendor/` 目录下，页面不依赖 CDN。

当前 OCR 使用本地 PaddleOCR。首次运行会下载/初始化 OCR 模型，耗时会比较久；后续会快很多。

## 代码结构

- `index.html`：Vue 页面模板和各业务弹窗
- `assets/style.css`：全局样式与各模块布局
- `js/main.js`：Vue 状态、计算属性和业务流程编排
- `js/core/runtime.js`：日期、富文本、Excel 单元格等公共工具
- `js/services/data-service.js`：后端读取、本地缓存和防抖串行保存
- `js/parsers/package-parser.js`：套餐截图/表格内容解析
- `js/parsers/daily-report-parser.js`：日常检验报告和检查报告解析
- `backend/app.py`：静态页面、数据接口和 PaddleOCR 服务
- `backend/data.json`：当前业务数据

## 报告数据结构

- `reports[]` 是检验报告和检查报告的唯一数据源，包含所属家人、日期、科室、结构化结果和原文件信息
- `dailyMonthRecords[].reportIds[]` 只保存日常台账与报告之间的关联
- 指标跟踪从 `reports[]` 中筛选已确认报告，不单独复制一套指标数据
- 旧版 `dailyMonthRecords[].reports[]` 会在加载时自动迁移；原指标入口导入的报告保持独立，原日常入口上传的报告保留关联

修改解析或保存逻辑后，可运行轻量语法检查：

```powershell
node --check js/main.js
node --check js/parsers/daily-report-parser.js
python -m py_compile backend/app.py
```

## 第一版边界

- 不做商业化和运营功能
- 不做多医院平台化
- 不做登录、账号和云同步
- 不直接信任 OCR 结果，必须人工核对后才入库
- 后端负责 OCR 和本地 JSON 数据保存，不做登录、账号和云同步
