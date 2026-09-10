# 视频类型配置中心

> 📚 本文档定义了生活服务视频的**类型识别系统**和**专属参数体系**。
> 
> 🎯 **核心理念**: 每种视频类型拥有独立的模型参数、叙事逻辑和生成规则，确保不同类型之间完全隔离，避免风格混淆。

---

## 📊 视频类型分类体系

### 类型 1：团购套餐介绍 (Package Promotion)

**核心目标**: 强调性价比，刺激冲动消费。

**触发关键词**:
- 团购、套餐、优惠、9.9、折扣、双人餐、套餐推荐、超值套餐

**典型场景**:
- 餐饮套餐（如：99元吃一桌）
- 酒店房券（如：399元住豪华套房）
- 娱乐票券（如：KTV欢唱券）

**专属参数**:
```yaml
type_id: "package_promo"
narrative_mode: "超值套餐种草模式"
visual_style: "高饱和度 + 暖色调 + 强烈食物质感"
camera_rhythm: "快速切换 (3-5秒/镜)"
max_shot_duration: 8
segments:
  - segment_id: "hook"
    duration: 3-5
    focus: "超值感/超级福利"
    visual: "热气腾腾的满桌菜品 + 强烈色彩对比"
  - segment_id: "full_view"
    duration: 5-8
    focus: "套餐全览"
    visual: "所有菜品展示"
  - segment_id: "specialty"
    duration: 10-15
    focus: "招牌特写"
    visual: "核心单品诱人画面"
  - segment_id: "environment"
    duration: 5-8
    focus: "环境/服务"
    visual: "舒适环境展示"
  - segment_id: "cta"
    duration: 3-5
    focus: "行动号召"
    visual: "人物自然指向画面外的动作"
```

**生成逻辑**:
1. 前3秒必须通过菜品份量、热气和人物惊喜反应表现超值感，不生成价格或文字
2. 菜品要有"食欲感"（热气、光泽、拉丝）
3. 通过食材丰富度和用餐场景强调性价比
4. 镜头节奏快，剪辑紧凑

---

### 类型 2：达人探店体验 (Store Visit)

**核心目标**: 种草店铺，提供真实体验参考。

**触发关键词**:
- 探店、打卡、网红店、体验、评测、试吃、开店、开店打卡

**典型场景**:
- 新店开业
- 网红店打卡
- 深度体验

**专属参数**:
```yaml
type_id: "store_visit"
narrative_mode: "沉浸式探店模式"
visual_style: "真实生活感 + 自然光 + 第一人称视角"
character_required: true
character_role: "探店达人"
camera_rhythm: "中等节奏 (5-8秒/镜)"
max_shot_duration: 10
segments:
  - segment_id: "introduction"
    duration: 3-5
    focus: "悬念/定位"
    visual: "我在XXX发现一家..."
  - segment_id: "first_impression"
    duration: 5-8
    focus: "装修风格/氛围"
    visual: "店铺环境展示"
  - segment_id: "experience"
    duration: 8-12
    focus: "点单/上菜/服务"
    visual: "真实体验过程"
  - segment_id: "feedback"
    duration: 10-15
    focus: "真实反馈"
    visual: "试吃口感点评"
  - segment_id: "summary"
    duration: 5-8
    focus: "推荐指数"
    visual: "适合人群总结"
```

**生成逻辑**:
1. 真实感第一（不要太像广告）
2. 有个人观点（好就是好，不好就是不好）
3. 提供实用信息（位置、停车、人均）
4. 镜头节奏适中，注重细节

---

### 类型 3：低价营销视频 (Low Price Marketing)

**核心目标**: 利用低价心理刺激冲动下单，模糊具体价格。

**触发关键词**:
- 低价、便宜、划算、破价、限时秒杀、代金券、抢券、囤券

**典型场景**:
- 餐饮代金券
- 酒店特价房
- 乐园特惠票

**专属参数**:
```yaml
type_id: "low_price_marketing"
narrative_mode: "低价悬念秒杀模式"
visual_style: "高冲击力 + 强对比色 + 快节奏剪辑"
camera_rhythm: "极快节奏 (2-4秒/镜)"
max_shot_duration: 5
segments:
  - segment_id: "hook"
    duration: 3
    focus: "视觉冲击与超值感"
    visual: "沸腾锅底与满桌菜品的快速近景"
  - segment_id: "package"
    duration: 5-8
    focus: "套餐/环境展示"
    visual: "满满一桌菜、舒适环境"
  - segment_id: "comparison"
    duration: 5-8
    focus: "模糊比价"
    visual: "丰富菜品与多人分享的满足感"
  - segment_id: "urgency"
    duration: 3-5
    focus: "限时紧迫"
    visual: "人物加快收尾动作与快速切镜"
  - segment_id: "cta"
    duration: 3-5
    focus: "强力号召"
    visual: "人物自然指向画面外并微笑示意"
```

**生成逻辑**:
1. **模糊价格**: 严禁出现具体金额数字
2. **视觉冲击**: 开场必须使用菜品蒸汽、人物反应、快速运镜或色彩对比，不生成手牌、标签或文字
3. **情绪调动**: 惊讶、不可思议、捡漏心理
4. 镜头节奏极快，甚至鬼畜剪辑

---

## 🔧 类型识别与路由系统

### 识别流程

```
用户输入
    │
    ├─ 包含"团购/套餐/优惠/9.9/折扣"？
    │   └─ 是 → 类型1: Package Promotion
    │
    ├─ 包含"探店/打卡/体验/评测"？
    │   └─ 是 → 类型2: Store Visit
    │
    ├─ 包含"低价/便宜/划算/秒杀/代金券"？
    │   └─ 是 → 类型3: Low Price Marketing
    │
    └─ 默认 → 类型1: Package Promotion (默认回退)
```

### 路由逻辑

```python
def route_video_type(user_input):
    keywords = {
        "package_promo": ["团购", "套餐", "优惠", "9.9", "折扣", "双人餐"],
        "store_visit": ["探店", "打卡", "体验", "评测", "试吃"],
        "low_price_marketing": ["低价", "便宜", "划算", "秒杀", "代金券"]
    }
    
    for type_id, kw_list in keywords.items():
        if any(kw in user_input for kw in kw_list):
            return type_id
    
    return "package_promo"  # 默认回退
```

---

## 📁 参考资源

- [`video-types.md`](video-types.md) - 视频类型详解
- [`story-patterns.md`](story-patterns.md) - 叙事模式参考
- [`visual-styles.md`](visual-styles.md) - 视觉风格参考
- [`questions-by-type.md`](questions-by-type.md) - 按类型的问题清单

---

*最后更新: 2026-03-12*
