export type PresetAvatarId =
  | 'asset-20260720212547-j4tns'
  | 'asset-20260720213034-z8rzr'
  | 'asset-20260720210605-r4fdc'
  | 'asset-20260720212016-qfsgq'
  | 'asset-20260804202300-dfnsm'
  | 'asset-20260720211601-76nqw'
  | 'asset-20260804202404-mzn8z';

export type AvatarVisualFamily = 'modern' | 'hanfu';

export type PresetOutfitId =
  | 'modern-store-visit'
  | 'modern-sexy-store-visit'
  | 'modern-commute'
  | 'modern-casual'
  | 'hanfu-ceremonial'
  | 'xianxia-traveler'
  | 'wuxia-heroine';

export interface PresetAvatar {
  id: PresetAvatarId;
  alias: string;
  displayName: string;
  style: AvatarVisualFamily;
  visualFamily: AvatarVisualFamily;
  description: string;
  identityPrompt: string;
  keywords: readonly string[];
  defaultOutfitId: PresetOutfitId;
  allowedOutfitIds: readonly PresetOutfitId[];
}

export interface PresetOutfit {
  id: PresetOutfitId;
  alias: string;
  visualFamilies: readonly AvatarVisualFamily[];
  allowedAvatarIds: readonly PresetAvatarId[];
  sceneTags: readonly string[];
  prompt: string;
}

export interface AvatarOutfitSelection {
  mode: 'preset' | 'custom';
  presetOutfitId?: PresetOutfitId;
  customPrompt?: string;
}

export interface AvatarOutfitInput {
  mode: 'preset' | 'custom';
  presetOutfitId?: string;
  customPrompt?: string;
}

export type AvatarCatalogValidation =
  | { success: true; outfit: AvatarOutfitSelection }
  | { success: false; message: string };

const MODERN_AVATAR_IDS = [
  'asset-20260720212547-j4tns',
  'asset-20260720213034-z8rzr',
  'asset-20260720210605-r4fdc',
  'asset-20260720212016-qfsgq',
] as const satisfies readonly PresetAvatarId[];

export const PRESET_AVATARS: readonly PresetAvatar[] = [
  {
    id: 'asset-20260720212547-j4tns',
    alias: '小叶',
    displayName: '小叶·软萌插画师',
    style: 'modern',
    visualFamily: 'modern',
    description: '软萌可爱的现代插画师风格虚拟人像',
    identityPrompt: '软萌可爱的年轻女性插画师，创意感强、表达亲和',
    keywords: ['创意', '美术', '文创', '设计', '年轻女性'],
    defaultOutfitId: 'modern-casual',
    allowedOutfitIds: [
      'modern-store-visit',
      'modern-sexy-store-visit',
      'modern-commute',
      'modern-casual',
    ],
  },
  {
    id: 'asset-20260720213034-z8rzr',
    alias: '程曦',
    displayName: '程曦·互联网实习生',
    style: 'modern',
    visualFamily: 'modern',
    description: '干练亲和的互联网大厂实习生风格虚拟人像',
    identityPrompt: '干练亲和的年轻女性互联网实习生，职场通勤气质',
    keywords: ['科技', '职场', '商务', '互联网', '通勤'],
    defaultOutfitId: 'modern-commute',
    allowedOutfitIds: [
      'modern-store-visit',
      'modern-sexy-store-visit',
      'modern-commute',
      'modern-casual',
    ],
  },
  {
    id: 'asset-20260720210605-r4fdc',
    alias: '青黛',
    displayName: '青黛·国风插画师',
    style: 'modern',
    visualFamily: 'modern',
    description: '现代国风插画师风格虚拟人像',
    identityPrompt: '温婉清新的女性国风插画师，现代国风气质',
    keywords: ['国风', '文旅', '传统文化', '非遗', '茶文化'],
    defaultOutfitId: 'modern-casual',
    allowedOutfitIds: [
      'modern-store-visit',
      'modern-sexy-store-visit',
      'modern-commute',
      'modern-casual',
    ],
  },
  {
    id: 'asset-20260720212016-qfsgq',
    alias: '小岚',
    displayName: '小岚·新媒体运营',
    style: 'modern',
    visualFamily: 'modern',
    description: '自然口播的新媒体运营风格虚拟人像',
    identityPrompt: '自然利落的女性新媒体运营，适合镜头前口播',
    keywords: ['探店', '餐饮', '本地生活', '带货', '口播'],
    defaultOutfitId: 'modern-store-visit',
    allowedOutfitIds: [
      'modern-store-visit',
      'modern-sexy-store-visit',
      'modern-casual',
      'modern-commute',
    ],
  },
  {
    id: 'asset-20260804202300-dfnsm',
    alias: '瑶琴',
    displayName: '瑶琴·先秦名伶',
    style: 'hanfu',
    visualFamily: 'hanfu',
    description: '先秦名伶风格虚拟人像',
    identityPrompt: '端庄典雅的女性先秦名伶，适用于先秦、历史和古典文化题材',
    keywords: ['先秦', '历史', '古典', '文化演绎'],
    defaultOutfitId: 'hanfu-ceremonial',
    allowedOutfitIds: ['hanfu-ceremonial'],
  },
  {
    id: 'asset-20260720211601-76nqw',
    alias: '云游',
    displayName: '云游·玄幻散修',
    style: 'hanfu',
    visualFamily: 'hanfu',
    description: '玄幻散修风格虚拟人像',
    identityPrompt: '清冷自在的女性玄幻散修，适用于仙侠、玄幻和奇幻题材',
    keywords: ['玄幻', '仙侠', '奇幻', '修仙'],
    defaultOutfitId: 'xianxia-traveler',
    allowedOutfitIds: ['xianxia-traveler'],
  },
  {
    id: 'asset-20260804202404-mzn8z',
    alias: '凌霜',
    displayName: '凌霜·武林女侠',
    style: 'hanfu',
    visualFamily: 'hanfu',
    description: '武林女侠客风格虚拟人像',
    identityPrompt: '英气果断的女性武林侠客，适用于武侠、江湖和古风剧情',
    keywords: ['武侠', '江湖', '古风', '女侠'],
    defaultOutfitId: 'wuxia-heroine',
    allowedOutfitIds: ['wuxia-heroine'],
  },
] as const;

export const PRESET_OUTFITS: readonly PresetOutfit[] = [
  {
    id: 'modern-store-visit',
    alias: '活力探店装',
    visualFamilies: ['modern'],
    allowedAvatarIds: MODERN_AVATAR_IDS,
    sceneTags: ['探店', '餐饮', '本地生活', '口播'],
    prompt:
      '奶油白修身短袖针织上衣，搭配深蓝高腰直筒牛仔裤，裤脚微露脚踝；白色厚底运动鞋，细银色耳钉与小巧腕表，干净利落，适合餐桌边自然口播。',
  },
  {
    id: 'modern-sexy-store-visit',
    alias: '性感探店装',
    visualFamilies: ['modern'],
    allowedAvatarIds: MODERN_AVATAR_IDS,
    sceneTags: ['精致餐饮', '夜间餐吧', '成熟探店', '口播'],
    prompt:
      '黑色一字肩修身针织上衣，露出肩部线条并微露锁骨与少量事业线；搭配高腰黑色铅笔裙与小侧开叉，轻薄黑色半透明丝袜、尖头细高跟鞋和小巧皮质手包，以简洁哑光材质为主，适合夜间餐吧或精致探店场景。',
  },
  {
    id: 'modern-commute',
    alias: '职场通勤装',
    visualFamilies: ['modern'],
    allowedAvatarIds: MODERN_AVATAR_IDS,
    sceneTags: ['职场', '科技', '商务', '通勤'],
    prompt:
      '象牙白垂感衬衫，领口自然微开并露出锁骨与少量事业线，搭配炭灰高腰直筒西装裤；黑色尖头低跟鞋、细金属表与小型耳圈，克制专业。',
  },
  {
    id: 'modern-casual',
    alias: '轻松日常装',
    visualFamilies: ['modern'],
    allowedAvatarIds: MODERN_AVATAR_IDS,
    sceneTags: ['文创', '设计', '街头', '文旅'],
    prompt:
      '雾粉色贴身短袖针织上衣，胸部线条自然明显，搭配米白及膝 A 字半裙；低饱和棕色玛丽珍鞋、珍珠耳钉，清新文艺。',
  },
  {
    id: 'hanfu-ceremonial',
    alias: '先秦礼服',
    visualFamilies: ['hanfu'],
    allowedAvatarIds: ['asset-20260804202300-dfnsm'],
    sceneTags: ['先秦', '历史', '古典文化'],
    prompt:
      '玄黑与黛青交叠的大袖深衣，衣襟以暗金云雷纹收边；宽腰封压住层叠下摆，玉质佩饰垂于腰侧，乌发高髻配青铜发簪，庄重克制。',
  },
  {
    id: 'xianxia-traveler',
    alias: '仙侠游侠装',
    visualFamilies: ['hanfu'],
    allowedAvatarIds: ['asset-20260720211601-76nqw'],
    sceneTags: ['仙侠', '玄幻', '奇幻'],
    prompt:
      '雾青色交领长衣外罩半透明浅灰披风，衣摆带轻微风化褶皱；深灰束腰、窄袖护腕与软底长靴，长发半束，清冷利落。',
  },
  {
    id: 'wuxia-heroine',
    alias: '武侠女侠装',
    visualFamilies: ['hanfu'],
    allowedAvatarIds: ['asset-20260804202404-mzn8z'],
    sceneTags: ['武侠', '江湖', '古风剧情'],
    prompt:
      '黑色立领短劲装，内搭暗红交领上衣，配深灰高腰裤与窄皮腰封；黑色长靴、简洁护腕，长发高束，英气明确。',
  },
] as const;

const LEGACY_AVATAR_ALIASES = new Set(['小洁', '小丽', '小蓉']);
const MODERN_CONFLICT_KEYWORDS = [
  '汉服',
  '古风',
  '先秦',
  '仙侠',
  '武侠',
  '江湖',
  '道袍',
  '襦裙',
];
const HANFU_CONFLICT_KEYWORDS = [
  '西装',
  '衬衫',
  '卫衣',
  '牛仔裤',
  '瑜伽裤',
  '运动内衣',
  '高跟鞋',
];

export function isLegacyAvatarAlias(value: string | undefined): boolean {
  return Boolean(value && LEGACY_AVATAR_ALIASES.has(value.trim()));
}

export function isPresetAvatarId(value: string): value is PresetAvatarId {
  return PRESET_AVATARS.some((avatar) => avatar.id === value);
}

export function isPresetOutfitId(value: string): value is PresetOutfitId {
  return PRESET_OUTFITS.some((outfit) => outfit.id === value);
}

export function getPresetAvatar(id: PresetAvatarId): PresetAvatar {
  const avatar = PRESET_AVATARS.find((item) => item.id === id);
  if (!avatar) {
    throw new Error(`未知虚拟人像 ID：${id}`);
  }
  return avatar;
}

export function findPresetAvatarByAlias(
  alias: string,
): PresetAvatar | undefined {
  return PRESET_AVATARS.find((avatar) => avatar.alias === alias.trim());
}

export function getPresetOutfit(id: PresetOutfitId): PresetOutfit {
  const outfit = PRESET_OUTFITS.find((item) => item.id === id);
  if (!outfit) {
    throw new Error(`未知预设服装 ID：${id}`);
  }
  return outfit;
}

export function validateAvatarOutfitSelection(
  avatar: PresetAvatar,
  selection?: AvatarOutfitInput,
): AvatarCatalogValidation {
  if (!selection) {
    return {
      success: true,
      outfit: { mode: 'preset', presetOutfitId: avatar.defaultOutfitId },
    };
  }

  if (selection.mode === 'preset') {
    if (
      !selection.presetOutfitId ||
      !isPresetOutfitId(selection.presetOutfitId)
    ) {
      return { success: false, message: '请选择有效的预设服装' };
    }
    const outfit = getPresetOutfit(selection.presetOutfitId);
    if (
      !outfit.visualFamilies.includes(avatar.visualFamily) ||
      !outfit.allowedAvatarIds.includes(avatar.id) ||
      !avatar.allowedOutfitIds.includes(outfit.id)
    ) {
      return {
        success: false,
        message: `${avatar.alias}不支持${outfit.alias}，请从该角色的兼容服装中选择`,
      };
    }
    return {
      success: true,
      outfit: { mode: 'preset', presetOutfitId: outfit.id },
    };
  }

  const customPrompt = selection.customPrompt?.trim();
  if (!customPrompt) {
    return { success: false, message: '自定义服装描述不能为空' };
  }
  const conflicts =
    avatar.visualFamily === 'modern'
      ? MODERN_CONFLICT_KEYWORDS
      : HANFU_CONFLICT_KEYWORDS;
  if (conflicts.some((keyword) => customPrompt.includes(keyword))) {
    const expectedFamily =
      avatar.visualFamily === 'modern' ? '现代服装' : '古风服装';
    return {
      success: false,
      message: `${avatar.alias}仅支持${expectedFamily}，请修改自定义服装描述`,
    };
  }
  return {
    success: true,
    outfit: { mode: 'custom', customPrompt },
  };
}

export function validateAvatarCatalogIntegrity(): void {
  if (PRESET_AVATARS.length !== 7) {
    throw new Error('虚拟人目录必须包含 7 个系统内置虚拟人');
  }

  const aliases = new Set<string>();
  for (const avatar of PRESET_AVATARS) {
    if (aliases.has(avatar.alias)) {
      throw new Error(`虚拟人别名重复：${avatar.alias}`);
    }
    aliases.add(avatar.alias);
    if (
      !avatar.defaultOutfitId ||
      !avatar.allowedOutfitIds.includes(avatar.defaultOutfitId)
    ) {
      throw new Error(`${avatar.alias}未配置有效的默认服装`);
    }
    const defaultOutfit = PRESET_OUTFITS.find(
      (outfit) => outfit.id === avatar.defaultOutfitId,
    );
    if (!defaultOutfit || !defaultOutfit.allowedAvatarIds.includes(avatar.id)) {
      throw new Error(`${avatar.alias}的默认服装不兼容`);
    }
    for (const outfitId of avatar.allowedOutfitIds) {
      const outfit = PRESET_OUTFITS.find((item) => item.id === outfitId);
      if (
        !outfit ||
        !outfit.visualFamilies.includes(avatar.visualFamily) ||
        !outfit.allowedAvatarIds.includes(avatar.id)
      ) {
        throw new Error(`${avatar.alias}关联了不兼容的服装`);
      }
    }
  }

  for (const outfit of PRESET_OUTFITS) {
    if (outfit.allowedAvatarIds.length === 0) {
      throw new Error(`${outfit.alias}未关联任何虚拟人`);
    }
    for (const avatarId of outfit.allowedAvatarIds) {
      const avatar = PRESET_AVATARS.find((item) => item.id === avatarId);
      if (!avatar || !avatar.allowedOutfitIds.includes(outfit.id)) {
        throw new Error(`${outfit.alias}关联了不兼容的虚拟人`);
      }
    }
  }
}

validateAvatarCatalogIntegrity();
