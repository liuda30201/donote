# 隐私区域（Private Zone）设计方案

> 状态：预留设计，待下一版本实施。当前版本保留卡片级 `private` 标记，但交互入口与区域隔离逻辑均未启用。

---

## 一、核心思路

现有的 `全部` / `收藏` Tab 旁边增加第三个 Tab：**隐私**（🔒）。

- 隐私区域是一个需要通过邮箱验证码才能进入的独立视图。
- 凡是被标记为 `private` 的卡片，在 `全部` 和 `收藏` 视图中**完全不显示**（不是模糊，而是从列表中隐去）。
- 只有进入隐私区域并完成验证后，才能看到这些卡片的完整内容。
- 验证状态是会话级的（可选临时时长），刷新或登出后重新锁定。

---

## 二、与现有方案的区别

| 维度 | 当前方案（v1，卡片级遮罩） | 新方案（v2，独立区域） |
|------|--------------------------|----------------------|
| 隐私卡片在全部视图 | 显示，但遮罩模糊 | **完全隐藏** |
| 解锁粒度 | 整个会话解锁所有卡片 | 进入隐私 Tab 时统一验证 |
| 入口 | 每张卡片上的🔒按钮 | Tab 栏"隐私"入口 |
| 验证时机 | 点击任一加密卡片时触发 | 点击隐私 Tab 时触发 |
| 视觉感知 | 用户知道存在多少加密卡片 | 其他视图完全感知不到 |

---

## 三、交互流程

### 3.1 将卡片标记为隐私

1. 在任意卡片操作栏点击🔒按钮。
2. 弹出确认提示："将此卡片移入隐私区域？移入后在全部/收藏视图中不再显示。"
3. 确认后立即从当前视图消失，写入 `private: true`。
4. 无需验证（加锁不需要身份校验）。

### 3.2 进入隐私区域

1. 点击 Tab 栏"🔒 隐私"。
2. 若当前会话已通过验证（`privateUnlocked === true`），直接显示卡片列表。
3. 若未验证，显示验证界面（居中卡片式，不是模态弹窗）：
   - 锁图标 + "隐私区域"标题 + 副标题说明
   - 时长选择：10分钟 / 30分钟 / 本次会话 / 永久解锁
   - "发送验证码"按钮 → 倒计时 → 输入框 → 6位自动提交
4. 验证通过后渲染卡片列表。

### 3.3 卡片列表视图

- 与 `全部` 视图相同的瀑布流卡片布局。
- 支持搜索、按类型筛选，但不显示 dock 上的分类 chip（隐私区域内不做分类筛选）。
- 卡片操作栏新增"移出隐私"按钮（解锁图标），点击弹确认后立即移回 `全部` 视图，无需再次验证。
- 右上角显示计时器倒计时（临时解锁模式），到期后自动跳回验证界面。

### 3.4 自动重锁

- 临时时长到期 → Tab 内容替换为验证界面，不弹出任何 toast 打扰其他操作。
- 切换到其他 Tab 后再切回隐私区域：
  - 会话解锁未过期 → 直接显示
  - 已过期 → 显示验证界面

---

## 四、数据模型变化

现有 `private` 字段无需改动，服务端已支持：

```js
// message.js — toPublicMessage 当前行为（v1）
// private: true 时仍返回 content，由前端控制显示

// v2 目标行为：
// GET /api/messages 时，private: true 的消息完全不在 messages 列表中返回
// GET /api/messages/private 新接口，需要会话通过隐私验证（header 或 cookie 携带验证令牌）
```

### 新增接口（v2）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/messages/private` | 获取隐私卡片列表，需验证令牌 |
| `POST` | `/api/messages/private/verify` | 验证邮箱验证码，返回会话令牌 |
| `POST` | `/api/messages/:id/private/toggle` | 加锁/解锁单张卡片（加锁无需验证） |

`/api/messages` 的现有接口在 v2 中需过滤掉 `private: true` 的消息（`storage.js` 的 `searchMessages` 和 `getMessagesPage` 均需更新，类比现有的 `sensitive` 过滤逻辑）。

---

## 五、前端实现要点

### 5.1 Tab 结构扩展

```html
<button class="tab" data-tab="private" role="tab">
  <svg><!-- 锁图标 --></svg>
  <span>隐私</span>
  <span id="private-badge" class="tab-badge hidden">0</span>
</button>
<div class="tab-panel" data-panel="private">
  <!-- 验证界面 或 卡片列表 -->
</div>
```

### 5.2 状态管理

```js
let privateUnlocked = false;
let privateUnlockExpiry = null;  // Date.now() + duration * 1000
let privateMessages = [];        // 独立于 messages 数组

function isPrivateSessionValid() {
  if (!privateUnlocked) return false;
  if (privateUnlockExpiry === null) return true; // 本次会话或永久
  return Date.now() < privateUnlockExpiry;
}
```

### 5.3 `全部` 和 `收藏` 视图过滤

```js
// renderTimelineList 里：
const filteredItems = items.filter(m => !m.private); // 对全部/收藏视图生效
```

### 5.4 dock 筛选 chip 联动

- 在隐私 Tab 内，dock 的类型筛选按钮正常工作，分类 chip 不显示。
- 切换 Tab 时重置分类筛选状态，避免残留筛选条件污染其他视图。

---

## 六、视觉设计

### Tab 入口

- 平时：锁图标 + "隐私"文字，徽章显示隐私卡片数量。
- 未解锁时图标轻微 pulse 动画（2s 一次，`animation: privateTabPulse`）。
- 解锁后：图标变为开锁状态，徽章显示解锁剩余时间（临时模式）。

### 验证界面（Tab 内，非弹窗）

```
┌─────────────────────────────────┐
│                                 │
│           🔒                    │
│        隐私区域                  │
│   验证身份后方可查看              │
│                                 │
│  [10分钟] [30分钟] [本次会话▼] [永久] │
│                                 │
│      [ 发送验证码 ]              │
│    ┌────────────────┐            │
│    │  _ _ _ _ _ _  │            │
│    └────────────────┘            │
│                                 │
└─────────────────────────────────┘
```

---

## 七、与 v1（当前）的兼容过渡

v1 中打了 `private: true` 的卡片，在升级到 v2 后：
- 服务端 `/api/messages` 过滤掉它们（不再返回）
- 它们自动出现在 `/api/messages/private` 中
- 数据无需迁移，`private` 字段保持不变

v1 前端中对 `is-private` 卡片的模糊/遮罩 CSS 可以保留作为降级处理，v2 中正常不会触发（因为 `全部` 视图里不再有 private 卡片）。

---

## 八、实施顺序建议

1. **服务端**：`getMessagesPage` / `searchMessages` 过滤 private；新增 `GET /api/messages/private`（复用现有 verify 端点鉴权）。
2. **前端 Tab**：新增隐私 Tab HTML + panel + 状态变量。
3. **验证界面**：复用现有的 `privateUnlockDurationRow` + 发码 + 自动提交逻辑，改为嵌入式而非弹窗。
4. **全部/收藏 过滤**：`renderTimelineList` 加 `m => !m.private` 过滤。
5. **卡片操作栏**：🔒按钮行为改为"移入/移出隐私区域"语义，去掉当前的解锁逻辑。
6. **徽章 & 计时器**：socket `message-private` 事件更新徽章；`setInterval` 每秒刷新解锁剩余时间显示。
