import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import OSS from 'ali-oss';
import { ConfigService } from '@nestjs/config';
import { OssFile } from './entities/oss.entity';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

const DEFAULT_TRANSFER_MAX_BYTES = 1024 * 1024 * 1024;

function isPrivateAddress(address: string): boolean {
  if (address === '::1' || address === '0.0.0.0') return true;
  if (
    address.startsWith('fe80:') ||
    address.startsWith('fc') ||
    address.startsWith('fd')
  )
    return true;
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

@Injectable()
export class OssService {
  private client: OSS;
  private readonly transferMaxBytes: number;

  constructor(
    configService: ConfigService,
    @InjectRepository(OssFile)
    private ossFileRepo: Repository<OssFile>,
  ) {
    this.client = new OSS({
      region: configService.get<string>('OSS_REGION'),
      accessKeyId: configService.get<string>('OSS_ACCESS_KEY_ID'),
      accessKeySecret: configService.get<string>('OSS_ACCESS_KEY_SECRET'),
      bucket: configService.get<string>('OSS_BUCKET_NAME'),
      // ali-oss 在 Node 端默认 secure=false，会签发 http:// 地址；
      // 前端运行在 https 站点上，http 资源会被浏览器判为混合内容而拦截。
      secure: true,
    });
    this.transferMaxBytes = Number(
      configService.get<string>('OSS_TRANSFER_MAX_BYTES') ||
        DEFAULT_TRANSFER_MAX_BYTES,
    );
  }

  /** 下载可信外部文件并流式转存到 OSS。 */
  async transferFromUrl(
    sourceUrl: string,
    options: {
      ossKey: string;
      fileName: string;
      allowedMimeTypes: string[];
      userId: number;
    },
  ) {
    const url = await this.validateTransferUrl(sourceUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new BadRequestException(
          `下载生成文件失败: HTTP ${response.status}`,
        );
      }

      const mimeType = (response.headers.get('content-type') || '')
        .split(';', 1)[0]
        .toLowerCase();
      if (!options.allowedMimeTypes.includes(mimeType)) {
        throw new BadRequestException(
          `不支持的生成文件类型: ${mimeType || 'unknown'}`,
        );
      }

      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > this.transferMaxBytes) {
        throw new BadRequestException('生成文件超过允许的转存大小');
      }

      const result = await this.client.put(
        options.ossKey,
        Readable.fromWeb(response.body as import('stream/web').ReadableStream),
        { mime: mimeType },
      );
      const ossFile = this.ossFileRepo.create({
        fileName: options.fileName,
        url: result.url,
        fileType: mimeType,
        createdBy: 'video_generation',
        userId: options.userId,
      });
      await this.ossFileRepo.save(ossFile);
      return { url: result.url, fileType: mimeType, ossKey: options.ossKey };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async validateTransferUrl(sourceUrl: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(sourceUrl);
    } catch {
      throw new BadRequestException('生成文件地址无效');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new BadRequestException('生成文件地址协议无效');
    }
    if (url.hostname === 'localhost') {
      throw new BadRequestException('生成文件地址不允许访问本机');
    }
    const addresses = await lookup(url.hostname, { all: true });
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => isPrivateAddress(address))
    ) {
      throw new BadRequestException('生成文件地址不允许访问内网');
    }
    return url;
  }

  /** 上传文件到 OSS，并将文件信息存入 MySQL */
  async uploadFile(
    originalName: string,
    fileBuffer: Buffer,
    mimeType: string,
    userId: number,
  ) {
    // 生成唯一文件名，保留原始扩展名
    const ext = originalName.split('.').pop() || '';
    const ossKey = `uploads/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const result = await this.client.put(ossKey, fileBuffer, {
      mime: mimeType,
    });

    // 将文件信息存入数据库
    const ossFile = this.ossFileRepo.create({
      fileName: originalName,
      url: result.url,
      fileType: mimeType,
      createdBy: 'system',
      userId,
    });
    await this.ossFileRepo.save(ossFile);

    return {
      id: ossFile.id,
      fileName: ossFile.fileName,
      url: ossFile.url,
      fileType: ossFile.fileType,
      createdAt: ossFile.createdAt,
    };
  }

  /** 分页查询文件记录 */
  async findAll(page: number = 1, pageSize: number = 10, userId: number) {
    const [list, total] = await this.ossFileRepo.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      list,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /** 查询单条记录 */
  findOne(id: number, userId: number) {
    return this.ossFileRepo.findOneBy({ id, userId });
  }

  /** 删除记录（仅删除数据库记录，不删除 OSS 文件） */
  async remove(id: number, userId: number) {
    const file = await this.ossFileRepo.findOneBy({ id, userId });
    if (!file) return null;
    await this.ossFileRepo.delete({ id, userId });
    return file;
  }
}
