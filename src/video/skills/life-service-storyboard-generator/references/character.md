# 角色与人像

每次创建脚本时，必须在 `generate_script` 的 `meta.character` 保存主角色选择。角色描述按需使用本文件，但图片来源按以下优先级决定：

1. 用户明确要求“使用这张脸”或“用上传人像出镜”时，使用 `mode=user_portrait`，填写该图片素材的 `primaryAssetId` 和 `selectionSource=user_explicit`。该图成为视频生成请求中的第一张图片。
2. 用户明确说出系统虚拟人简称时，使用 `mode=preset_avatar`，填写匹配的 `presetAvatarId`、`presetAlias`、`outfit` 和 `selectionSource=user_explicit`。
3. 未指定来源但脚本需要人物时，根据商品画像、题材和店铺调性自动选择预置虚拟人像，并填写 `selectionSource=auto_selected`。
4. 不需要人物出镜时，使用 `mode=none`。

用户上传人像但未明确要求其作为主角色时，只能作为分析素材，不得自动绑定。`user_portrait` 与 `preset_avatar` 互斥，不得在同一视频请求中混用真人主角色和虚拟人像；同一句出现互斥角色指令时必须追问。

可用系统虚拟人像如下。用户指定服装时，只能使用该角色的可选服装或兼容的自定义服装；未指定时使用默认服装，且不得跨现代和古风视觉族群搭配。

- `小叶`：`asset-20260720212547-j4tns`，软萌可爱插画师风格。
- `程曦`：`asset-20260720213034-z8rzr`，互联网大厂实习生风格。
- `青黛`：`asset-20260720210605-r4fdc`，国风插画师风格。
- `小岚`：`asset-20260720212016-qfsgq`，新媒体运营风格。
- `瑶琴`：`asset-20260804202300-dfnsm`，先秦名伶风格。
- `云游`：`asset-20260720211601-76nqw`，玄幻散修风格。
- `凌霜`：`asset-20260804202404-mzn8z`，武林女侠客风格。

若用户要求已下线的旧文本角色，必须要求其从上述 7 个系统虚拟人中选择；禁止自动映射或保存脚本。角色设定写入 `roleName` 和 `rolePrompt`。

