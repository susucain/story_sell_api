import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { generateObject } from 'ai';
import { z } from 'zod/v4';
import { In, Repository } from 'typeorm';
import { VideoAgentExecutionService, VideoAgentTimeoutError } from './video-agent-execution.service';
import { AssetContentCategory, VideoAsset } from './entities/video-asset.entity';
import { VideoLLMService } from './video-llm.service';

const CONTENT_CATEGORIES = [
  'portrait',
  'product',
  'food',
  'store',
  'environment',
  'other',
] as const;

const analysisSchema = z.object({
  summary: z.string().min(1).max(500),
  contentCategory: z.enum(CONTENT_CATEGORIES),
});

export type VideoAssetAnalysisResult =
  | {
    assetId: number;
    status: 'parsed';
    summary: string;
    contentCategory: AssetContentCategory;
  }
  | {
    assetId: number;
    status: 'failed';
    errorCode: 'ASSET_PARSE_TIMEOUT' | 'ASSET_PARSE_FAILED';
  };

@Injectable()
export class VideoAssetAnalysisService {
  constructor(
    @InjectRepository(VideoAsset)
    private readonly assetRepo: Repository<VideoAsset>,
    private readonly llmService: VideoLLMService,
    private readonly executionService: VideoAgentExecutionService,
  ) {}

  async analyzePendingAssets(
    sessionId: string,
    assetIds: number[],
    parentSignal?: AbortSignal,
  ): Promise<VideoAssetAnalysisResult[]> {
    if (assetIds.length === 0) return [];
    this.throwIfParentAborted(parentSignal);

    const candidates = await this.assetRepo.find({
      where: {
        sessionId,
        id: In(assetIds),
        assetPurpose: In(['all', 'analysis']),
        status: In(['pending', 'failed']),
      },
      order: { createdAt: 'ASC' },
    });
    const assets: VideoAsset[] = [];
    for (const asset of candidates) {
      this.throwIfParentAborted(parentSignal);
      const claim = await this.assetRepo.update(
        {
          id: asset.id,
          sessionId,
          assetPurpose: In(['all', 'analysis']),
          status: In(['pending', 'failed']),
        },
        { status: 'parsing' },
      );
      if (claim.affected === 1) {
        asset.status = 'parsing';
        assets.push(asset);
      }
    }

    const results: VideoAssetAnalysisResult[] = new Array(assets.length);
    let nextIndex = 0;
    const workerCount = Math.min(
      this.executionService.assetAnalysisConcurrency,
      assets.length,
    );

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < assets.length) {
          this.throwIfParentAborted(parentSignal);
          const index = nextIndex++;
          results[index] = await this.analyzeAsset(assets[index], parentSignal);
        }
      }),
    );

    return results;
  }

  private async analyzeAsset(
    asset: VideoAsset,
    parentSignal?: AbortSignal,
  ): Promise<VideoAssetAnalysisResult> {
    try {
      this.throwIfParentAborted(parentSignal);
      const result = await this.executionService.runAssetParse(
        {
          sessionId: asset.sessionId,
          assetId: asset.id,
          parentSignal,
        },
        async (signal) => generateObject({
          model: this.llmService.getLanguageModel(),
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analyze this visual asset. Return JSON with a concise summary and contentCategory from: portrait, product, food, store, environment, other.',
              },
              {
                type: 'file',
                data: new URL(asset.url),
                mediaType: 'image/jpeg',
                providerOptions: asset.assetType === 'video'
                  ? { openaiCompatible: { qwenVideoInput: true } }
                  : undefined,
              },
            ],
          }],
          schema: analysisSchema,
          abortSignal: signal,
        }),
      );
      this.throwIfParentAborted(parentSignal);
      const parsed = result.object;
      const contentCategory = parsed.contentCategory as AssetContentCategory;
      asset.parsedContent = {
        ...(asset.parsedContent ?? {}),
        summary: parsed.summary,
        contentCategory,
      };
      asset.contentCategory = contentCategory;
      asset.status = 'parsed';
      await this.assetRepo.save(asset);
      return {
        assetId: asset.id,
        status: 'parsed',
        summary: parsed.summary,
        contentCategory,
      };
    } catch (error) {
      if (parentSignal?.aborted) {
        throw parentSignal.reason;
      }
      const errorCode = this.getErrorCode(error);
      try {
        asset.parsedContent = {
          ...(asset.parsedContent ?? {}),
          errorCode,
        };
        asset.status = 'failed';
        await this.assetRepo.save(asset);
      } catch {
        // A persistence failure must not prevent sibling analysis results.
      }
      return { assetId: asset.id, status: 'failed', errorCode };
    }
  }

  private getErrorCode(
    error: unknown,
  ): 'ASSET_PARSE_TIMEOUT' | 'ASSET_PARSE_FAILED' {
    return this.isAssetParseTimeout(error)
      ? 'ASSET_PARSE_TIMEOUT'
      : 'ASSET_PARSE_FAILED';
  }

  private isAssetParseTimeout(error: unknown): error is VideoAgentTimeoutError {
    return error instanceof VideoAgentTimeoutError
      && error.code === 'ASSET_PARSE_TIMEOUT';
  }

  private throwIfParentAborted(parentSignal?: AbortSignal): void {
    if (parentSignal?.aborted) {
      throw parentSignal.reason;
    }
  }
}
