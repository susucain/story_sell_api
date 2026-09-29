import { Injectable } from '@nestjs/common';

/** 视频创作流水线中的角色标识。 */
export type RoleId =
  | 'director'
  | 'screenwriter'
  | 'shot-planner'
  | 'cinematographer'
  | 'reviewer';

export interface RoleProfile {
  id: RoleId;
  /** 展示名，用于过程面板与提示词身份描述。 */
  displayName: string;
  /** 系统提示词中的身份说明。 */
  identity: string;
  /** 该角色可读取的技能目录名。 */
  allowedSkills: string[];
  /** 该角色可调用的工具白名单。 */
  allowedTools: string[];
  /** 该角色需要把任务分派给哪些子角色。 */
  dispatches?: RoleId[];
  /** 该角色产出结构的提示，供编排层校验。 */
  outputSchemaHint?: string;
  /** 该角色绑定的垂类，缺省表示通用。 */
  vertical?: string;
}

/** 所有角色都需要的只读查询工具。 */
const READ_ONLY_TOOLS = [
  'get_script',
  'list_scripts',
  'get_video_task_status',
  'get_session_state',
];

export const ROLE_PROFILES: Record<RoleId, RoleProfile> = {
  director: {
    id: 'director',
    displayName: '总导演',
    identity:
      '你是视频创作的负责人（总导演），负责理解用户意图、统筹脚本创作与视频生成；必要时把专业任务分派给编剧、导演、摄影等角色。',
    allowedSkills: ['life-service-storyboard-generator'],
    allowedTools: [
      'read_file',
      'write_file',
      'update_creative_brief',
      'request_user_confirmation',
      'create_video_task',
      ...READ_ONLY_TOOLS,
    ],
    dispatches: ['screenwriter', 'shot-planner', 'cinematographer'],
    outputSchemaHint: '返回创作简报与已完成角色列表。',
  },
  screenwriter: {
    id: 'screenwriter',
    displayName: '编剧',
    identity: '你是编剧，负责根据创作简报产出剧本、台词与分镜脚本。',
    allowedSkills: ['life-service-storyboard-generator'],
    allowedTools: [
      'start_script_creation',
      'read_file',
      'write_file',
      'update_creative_brief',
      'generate_script',
      'complete_without_script_change',
      'request_user_confirmation',
      ...READ_ONLY_TOOLS,
    ],
    outputSchemaHint: '返回 title 与 storyboard_markdown。',
  },
  'shot-planner': {
    id: 'shot-planner',
    displayName: '导演',
    identity: '你是导演，负责把剧本拆解为可拍摄的分镜、节奏与时长安排。',
    allowedSkills: ['life-service-storyboard-generator'],
    allowedTools: [
      'read_file',
      'write_file',
      'generate_script',
      'complete_without_script_change',
      'request_user_confirmation',
      ...READ_ONLY_TOOLS,
    ],
    outputSchemaHint: '返回镜头列表与每个镜头的时长。',
  },
  cinematographer: {
    id: 'cinematographer',
    displayName: '摄影',
    identity: '你是摄影指导，负责画面、运镜与 Seedance 提示词的视觉表达。',
    allowedSkills: ['life-service-storyboard-generator', 'sd2-pe'],
    allowedTools: ['read_file', 'write_file', ...READ_ONLY_TOOLS],
    outputSchemaHint: '返回每个镜头的 seedance_prompt。',
  },
  reviewer: {
    id: 'reviewer',
    displayName: '质检',
    identity: '你是质检角色，负责校验字幕、安全与脚本一致性等红线。',
    allowedSkills: ['life-service-storyboard-generator', 'sd2-pe'],
    allowedTools: ['read_file', ...READ_ONLY_TOOLS],
    outputSchemaHint: '返回问题列表与严重级别。',
  },
};

@Injectable()
export class AgentRoleRegistryService {
  getRoleProfile(id: RoleId): RoleProfile {
    if (!Object.hasOwn(ROLE_PROFILES, id)) {
      throw new Error(`未知 agent role：${id}`);
    }
    return ROLE_PROFILES[id];
  }

  listRoleProfiles(): RoleProfile[] {
    return Object.values(ROLE_PROFILES);
  }
}