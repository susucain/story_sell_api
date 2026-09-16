import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { generateObject } from 'ai';
import { z } from 'zod/v4';
import { In, Not, Repository } from 'typeorm';
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
    parentSignal?: AbortSignal,
  ): Promise<VideoAssetAnalysisResult[]> {
    const assets = await this.assetRepo.find({
      where: {
        sessionId,
        assetPurpose: In(['all', 'analysis']),
        status: Not('parsed'),
      },
      order: { createdAt: 'ASC' },
    });
    const results: VideoAssetAnalysisResult[] = new Array(assets.length);
    let nextIndex = 0;
    const workerCount = Math.min(
      this.executionService.assetAnalysisConcurrency,
      assets.length,
    );

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < assets.length) {
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
      const parsed = result.object;
      const contentCategory = parsed.contentCategory as AssetContentCategory;
      asset.parsedContent = {
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
      const errorCode = this.getErrorCode(error);
      try {
        asset.parsedContent = { errorCode };
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
    return error instanceof VideoAgentTimeoutError
      && error.code === 'ASSET_PARSE_TIMEOUT'
      ? 'ASSET_PARSE_TIMEOUT'
      : 'ASSET_PARSE_FAILED';
  }
}
