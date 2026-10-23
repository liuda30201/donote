# Twemoji 集成指南

## 概述
将 Twemoji 集成到 DoNote 头像系统中，提供 49+ 个高质量 emoji 头像选项，按 4 个分类展示。

## 1. 引入 Twemoji CDN

在 `app/public/app.html` 的 `<head>` 标签中添加：

```html
<script src="https://cdn.jsdelivr.net/npm/@twemoji/api@15.1.0/dist/twemoji.min.js" crossorigin="anonymous"></script>
```

位置：在 `</head>` 标签之前

## 2. HTML 结构更新

### 2.1 替换头像选择器 HTML

找到 `app/public/app.html` 中的头像编辑器部分（大约在第 778-811 行），替换为以下内容：

```html
        <!-- 头像选择器 -->
        <div class="avatar-editor-section">
          <h4 class="avatar-editor-section-title">选择头像</h4>
          
          <!-- 分类标签 -->
          <div class="avatar-category-tabs">
            <button class="avatar-category-tab active" data-category="faces" type="button">😊 表情</button>
            <button class="avatar-category-tab" data-category="animals" type="button">🐶 动物</button>
            <button class="avatar-category-tab" data-category="symbols" type="button">⭐ 符号</button>
            <button class="avatar-category-tab" data-category="hobbies" type="button">🎮 兴趣</button>
          </div>
          
          <!-- 预设图标网格 -->
          <div id="avatar-preset-grid" class="avatar-preset-grid">
            <!-- 表情分类 (16个) -->
            <div class="avatar-category-content active" data-category="faces">
              <button class="avatar-preset-item" data-type="emoji" data-value="😀" type="button">😀</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="😃" type="button">😃</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="😄" type="button">😄</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="😁" type="button">😁</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="😆" type="button">😆</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="😊" type="button">😊</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🥰" type="button">🥰</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="😎" type="button">😎</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🤓" type="button">🤓</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🧐" type="button">🧐</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🤠" type="button">🤠</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🥳" type="button">🥳</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="😇" type="button">😇</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🤗" type="button">🤗</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🤔" type="button">🤔</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="😌" type="button">😌</button>
            </div>
            
            <!-- 动物分类 (16个) -->
            <div class="avatar-category-content" data-category="animals">
              <button class="avatar-preset-item" data-type="emoji" data-value="🐶" type="button">🐶</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐱" type="button">🐱</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐭" type="button">🐭</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐹" type="button">🐹</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐰" type="button">🐰</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🦊" type="button">🦊</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐻" type="button">🐻</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐼" type="button">🐼</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐨" type="button">🐨</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐯" type="button">🐯</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🦁" type="button">🦁</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐮" type="button">🐮</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐷" type="button">🐷</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐸" type="button">🐸</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🐵" type="button">🐵</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🦄" type="button">🦄</button>
            </div>
            
            <!-- 符号分类 (13个,含 TG 图标) -->
            <div class="avatar-category-content" data-category="symbols">
              <button class="avatar-preset-item" data-type="emoji" data-value="⭐" type="button">⭐</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="💫" type="button">💫</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="✨" type="button">✨</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🔥" type="button">🔥</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="💎" type="button">💎</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="👑" type="button">👑</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🎯" type="button">🎯</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🎨" type="button">🎨</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🎭" type="button">🎭</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🎪" type="button">🎪</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🎸" type="button">🎸</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🚀" type="button">🚀</button>
              <button class="avatar-preset-item" data-type="icon" data-value="tg-plane" type="button">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" style="color: #0088cc;">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
                </svg>
              </button>
            </div>
            
            <!-- 兴趣分类 (12个) -->
            <div class="avatar-category-content" data-category="hobbies">
              <button class="avatar-preset-item" data-type="emoji" data-value="⚽" type="button">⚽</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🏀" type="button">🏀</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🎮" type="button">🎮</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🎲" type="button">🎲</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🎸" type="button">🎸</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🎹" type="button">🎹</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="📚" type="button">📚</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="☕" type="button">☕</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🍕" type="button">🍕</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🌮" type="button">🌮</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🍦" type="button">🍦</button>
              <button class="avatar-preset-item" data-type="emoji" data-value="🎂" type="button">🎂</button>
            </div>
          </div>
        </div>
```

## 3. CSS 样式更新

在 `app/public/style.css` 中添加以下样式（建议在头像编辑器相关样式区域）：

```css
/* 头像分类标签 */
.avatar-category-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  padding: 4px;
  background: var(--surface-1);
  border-radius: 8px;
}

.avatar-category-tab {
  flex: 1;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.82rem;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.avatar-category-tab:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}

.avatar-category-tab.active {
  background: var(--brand);
  color: white;
}

/* 分类内容容器 */
.avatar-category-content {
  display: none;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
}

.avatar-category-content.active {
  display: grid;
}

@media (max-width: 500px) {
  .avatar-category-content {
    grid-template-columns: repeat(4, 1fr);
  }
}

/* Twemoji 图片样式 */
.avatar-preset-item img.emoji {
  width: 24px;
  height: 24px;
  vertical-align: middle;
}
```

## 4. JavaScript 更新

### 4.1 分类标签切换逻辑

在 `app/public/app.js` 中，找到 `// ========== 头像编辑器 ==========` 部分，在开头添加：

```javascript
// 分类标签切换
document.querySelectorAll('.avatar-category-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const category = tab.dataset.category;
    
    // 切换标签状态
    document.querySelectorAll('.avatar-category-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    
    // 切换内容显示
    document.querySelectorAll('.avatar-category-content').forEach(content => {
      content.classList.toggle('active', content.dataset.category === category);
    });
  });
});
```

### 4.2 Twemoji 渲染函数

在打开头像编辑器的代码中，添加 Twemoji 渲染：

找到 `avatarEditTrigger?.addEventListener('click', ...)` 函数，在 `closeSettingsPopover();` 之前添加：

```javascript
  // 渲染 Twemoji
  if (typeof twemoji !== 'undefined') {
    twemoji.parse(avatarEditorModal, {
      folder: 'svg',
      ext: '.svg'
    });
  }
```

### 4.3 更新头像预览函数

找到 `function updateAvatarPreview(avatar)` 函数，在处理 emoji 的分支中添加 Twemoji 渲染：

```javascript
function updateAvatarPreview(avatar) {
  if (!avatarPreviewLarge) return;
  
  if (avatar.type === 'emoji' || avatar.type === 'icon') {
    if (avatar.value === 'tg-plane') {
      // TG 图标保持不变
      avatarPreviewLarge.innerHTML = `...`;
    } else {
      // Emoji 文本
      avatarPreviewLarge.innerHTML = avatar.value;
      // 渲染为 Twemoji
      if (typeof twemoji !== 'undefined') {
        twemoji.parse(avatarPreviewLarge, {
          folder: 'svg',
          ext: '.svg'
        });
      }
    }
  } else {
    avatarPreviewLarge.textContent = avatar.value.toUpperCase();
  }
}
```

### 4.4 更新 applyAvatarToUI 函数

找到 `function applyAvatarToUI(avatar)` 函数，在两处头像显示中都添加 Twemoji 渲染：

```javascript
// 顶栏头像
if (avatar.type === 'emoji' || avatar.type === 'icon') {
  if (avatar.value === 'tg-plane') {
    topbarUserAvatar.innerHTML = `<svg>...</svg>`;
  } else {
    topbarUserAvatar.innerHTML = avatar.value;
    // 渲染 Twemoji
    if (typeof twemoji !== 'undefined') {
      twemoji.parse(topbarUserAvatar, {
        folder: 'svg',
        ext: '.svg'
      });
    }
  }
}

// 设置弹窗头像（同理）
```

## 5. 测试检查清单

- [ ] Twemoji CDN 加载成功（检查控制台无404错误）
- [ ] 头像编辑器可以打开
- [ ] 4个分类标签可以正常切换
- [ ] 每个分类显示正确的 emoji 数量
- [ ] 点击 emoji 能选中并更新预览
- [ ] Emoji 渲染为 Twitter 风格的 SVG 图片
- [ ] 保存后顶栏和设置弹窗中的头像正常显示
- [ ] 自定义文字功能正常
- [ ] Telegram 飞机图标显示正常

## 6. 优势总结

✅ **49+ 个精选头像**  
✅ **4 个清晰分类**（表情/动物/符号/兴趣）  
✅ **跨平台一致显示**（不受系统 emoji 字体影响）  
✅ **无需额外下载资源**（CDN 加载）  
✅ **保留自定义文字和 TG 图标**

## 文件清单

需要修改的文件：
1. `app/public/app.html` - 添加 Twemoji CDN + 更新头像选择器 HTML
2. `app/public/style.css` - 添加分类标签和内容样式
3. `app/public/app.js` - 添加分类切换逻辑 + Twemoji 渲染调用
