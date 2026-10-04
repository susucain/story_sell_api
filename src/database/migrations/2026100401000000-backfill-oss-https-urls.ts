import { MigrationInterface, QueryRunner } from 'typeorm';

const DEFAULT_BUCKET = 'oss-ai-bucket';
const DEFAULT_REGION = 'oss-cn-hangzhou';

/** 需要把自有 OSS 地址从 http 升级为 https 的文本列 */
const TEXT_COLUMNS: Array<[string, string]> = [
  ['oss_files', 'url'],
  ['video_assets', 'url'],
  ['video_assets', 'thumbnail_url'],
  ['video_tasks', 'image_urls'],
  ['video_tasks', 'video_urls'],
  ['video_tasks', 'generated_video_url'],
  ['video_tasks', 'last_frame_url'],
  ['video_generation_plans', 'assembled_video_url'],
  ['users', 'avatar_url'],
];

/** JSON 列同样可能内嵌 OSS 地址（聊天附件、视频卡片元数据、工具调用参数） */
const JSON_COLUMNS: Array<[string, string]> = [
  ['video_message', 'parts'],
  ['video_message', 'metadata'],
  ['video_message', 'tool_calls'],
];

/**
 * 把历史数据里的自有 OSS 地址从 http 升级为 https。
 *
 * 修复前 OSS 客户端未开启 secure，签发的地址形如
 * http://oss-ai-bucket.oss-cn-hangzhou.aliyuncs.com/...，在 https 站点（storysell.cn）
 * 上被浏览器判为混合内容并拦截。新数据已由 secure: true 修正，这里回填旧数据。
 *
 * 只替换自有 bucket 域名，第三方地址（如火山方舟的签名链接）保持原样；
 * 仅命中仍为 http 的记录，可安全重复执行。
 */
export class BackfillOssHttpsUrls1791075600000 implements MigrationInterface {
  name = 'BackfillOssHttpsUrls1791075600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const bucket = process.env.OSS_BUCKET_NAME || DEFAULT_BUCKET;
    const region = process.env.OSS_REGION || DEFAULT_REGION;
    const insecureHost = `http://${bucket}.${region}.aliyuncs.com`;
    const secureHost = `https://${bucket}.${region}.aliyuncs.com`;
    const like = `%${insecureHost}%`;

    for (const [table, column] of TEXT_COLUMNS) {
      if (!(await queryRunner.hasTable(table))) continue;
      if (!(await queryRunner.hasColumn(table, column))) continue;
      await queryRunner.query(
        `UPDATE \`${table}\` SET \`${column}\` = REPLACE(\`${column}\`, ?, ?) WHERE \`${column}\` LIKE ?`,
        [insecureHost, secureHost, like],
      );
    }

    for (const [table, column] of JSON_COLUMNS) {
      if (!(await queryRunner.hasTable(table))) continue;
      if (!(await queryRunner.hasColumn(table, column))) continue;
      await queryRunner.query(
        `UPDATE \`${table}\`
            SET \`${column}\` = CAST(
              REPLACE(CAST(\`${column}\` AS CHAR), ?, ?) AS JSON
            )
          WHERE CAST(\`${column}\` AS CHAR) LIKE ?`,
        [insecureHost, secureHost, like],
      );
    }
  }

  async down(): Promise<void> {
    // 无法区分某条记录原本是 http 还是 https，回滚会把本就安全的地址改成 http，
    // 反而重新引入混合内容问题，故不提供回滚。
  }
}
