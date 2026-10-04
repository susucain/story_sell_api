import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';

@Injectable()
export class LLMService {
  constructor(private readonly configService: ConfigService) {}

  getModel() {
    return new ChatOpenAI({
      temperature: 0,
      modelName: this.configService.get<string>('MODEL_NAME'),
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
      configuration: {
        baseURL: this.configService.get<string>('OPENAI_BASE_URL'),
      },
      modelKwargs: {
        // 对于我的场景思考模式没必要开启
        /**
                 * 思考模式（extended thinking）对以下场景有明显提升：
                    - 复杂数学推理
                    - 多步骤代码生成（需要规划架构）
                    - 逻辑谜题、因果推理
                    - 需要"先想清楚再动手"的任务
                 */
        enable_thinking: false,
      },
    });
  }
}
