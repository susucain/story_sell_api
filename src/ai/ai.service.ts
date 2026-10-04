import { Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import type { Runnable } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { Inject } from '@nestjs/common';
import {
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { StructuredTool } from '@langchain/core/tools';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AI_TTS_STREAM_EVENT } from '../common/stream-events';
import { createAgent } from 'langchain';
import { toBaseMessages, toUIMessageStream } from '@ai-sdk/langchain';
import { UIMessage } from 'ai';

@Injectable()
export class AiService {
  private readonly chain: Runnable;
  private readonly modelWithTool: Runnable;

  private readonly tools: StructuredTool[];
  private readonly agent: ReturnType<typeof createAgent>;

  constructor(
    @Inject('CHAT_MODEL') model: ChatOpenAI,
    @Inject('QUERY_USER_TOOL') private readonly queryUserTool: any,
    @Inject('SEND_MAIL_TOOL') private readonly sendMailTool: any,
    @Inject('WEB_SEARCH_TOOL') private readonly webSearchTool: any,
    @Inject('DB_USERS_CRUD_TOOL') private readonly dbUsersCrudTool: any,
    @Inject('CRON_JOB_TOOL') private readonly cronJobTool: any,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const prompt = PromptTemplate.fromTemplate('请回答以下问题：\n\n{query}');

    this.chain = prompt.pipe(model).pipe(new StringOutputParser());
    this.tools = [
      this.queryUserTool,
      this.sendMailTool,
      this.webSearchTool,
      this.dbUsersCrudTool,
      this.cronJobTool,
    ];
    this.modelWithTool = model.bindTools(this.tools);

    // 创建智能体(langchain实现，会自动实现agent loop)
    this.agent = createAgent({
      model: model,
      tools: this.tools,
      systemPrompt:
        '你是 AI 助手，需要最新信息、事实核查或联网信息时，请使用 web_search 工具搜索后再作答。',
    });
  }

  async runChain(query: string): Promise<string> {
    return this.chain.invoke({ query });
  }

  async *streamChain(query: string, ttsSessionId?: string) {
    const stream = await this.chain.stream({ query });
    for await (const chunk of stream) {
      if (ttsSessionId) {
        const event = {
          type: 'chunk',
          sessionId: ttsSessionId,
          chunk,
        };
        this.eventEmitter.emit(AI_TTS_STREAM_EVENT, event);
      }
      yield chunk;
    }
  }

  async runChainWithTool(query: string): Promise<string> {
    const history = new InMemoryChatMessageHistory();

    history.addMessages([
      new SystemMessage(
        `你是一个通用任务助手，可以根据用户的目标规划步骤，并在需要时调用工具：\`query_user\` 查询或校验用户信息、\`send_mail\` 发送邮件、\`web_search\` 进行互联网搜索、\`db_users_crud\` 读写数据库 users 表、\`cron_job\` 创建和管理定时/周期任务（\`list\`/\`add\`/\`toggle\`），从而实现提醒、定期任务、数据同步等各种自动化需求。

定时任务类型选择规则（非常重要）：
- 用户说“X分钟/小时/天后”“在某个时间点”“到点提醒”（一次性）=> 用 \`cron_job\` + \`type=at\`（执行一次后自动停用），\`at\`=当前时间+X 或解析出的时间点
- 用户说“每X分钟/每小时/每天”“定期/循环/一直”（重复执行）=> 用 \`cron_job\` + \`type=every\`（每次执行），\`everyMs\`=X换算成毫秒
- 用户给出 Cron 表达式或明确说“用 cron 表达式”（重复执行）=> 用 \`cron_job\` + \`type=cron\`

在调用 \`cron_job.add\` 创建任务时，需要把用户原始自然语言拆成两部分：一部分是“什么时候执行”（用来决定 type/at/everyMs/cron），另一部分是“要做什么任务本身”。\`instruction\` 字段只能填“要做什么”的那部分文本（保持原语言和原话），不能再改写、翻译或总结。

当用户请求“在未来某个时间点执行某个动作”（例如“1分钟后给我发一个笑话到邮箱”）时，本轮对话只需要使用 \`cron_job\` 设置/更新定时任务，不要在当前轮直接完成这个动作本身：不要直接调用 \`send_mail\` 给他发邮件，也不要在当前轮就真正“执行”指令，只需把要执行的动作写进 \`instruction\` 里，交给将来的定时任务去跑。

注意：像“\`1分钟后提醒我喝水\`”，时间相关信息用于计算下一次执行时间，而 \`instruction\` 应该是“提醒我喝水”；本轮不需要立刻提醒。`,
      ),
      new HumanMessage(query),
    ]);

    while (true) {
      const messages = await history.getMessages();
      const aiMessage = await this.modelWithTool.invoke(messages);
      history.addMessage(aiMessage);

      const toolCalls = aiMessage.tool_calls ?? [];

      // 没有要调用的工具，直接把回答返回给调用方
      if (!toolCalls.length) {
        return aiMessage.content as string;
      }

      // 依次执行本轮需要调用的所有工具
      for (const toolCall of toolCalls) {
        const tool = this.tools.find((t) => t.name === toolCall.name);

        if (!tool) {
          continue;
        }

        const result = await tool.invoke(toolCall.args);

        history.addMessage(
          new ToolMessage({
            tool_call_id: toolCall.id || '',
            name: toolCall.name,
            content: result,
          }),
        );
      }
    }
  }

  async *runChainWithToolStream(query: string) {
    const history = new InMemoryChatMessageHistory();

    history.addMessages([
      new SystemMessage(
        '你是一个智能助手，可以在需要时调用工具（如 query_user）来查询用户信息，再用结果回答用户的问题。',
      ),
      new HumanMessage(query),
    ]);

    while (true) {
      const messages = await history.getMessages();
      const aiMessage = (await this.modelWithTool.stream(
        messages,
      )) as AsyncIterable<AIMessageChunk>;

      let fullAIMsg: AIMessageChunk | null = null;
      for await (const chunk of aiMessage) {
        fullAIMsg = fullAIMsg ? fullAIMsg.concat(chunk) : chunk;

        if (!fullAIMsg?.tool_calls?.length && chunk.content) {
          yield chunk.content;
        }
      }

      if (!fullAIMsg) {
        return;
      }

      history.addMessage(fullAIMsg);

      const toolCalls = fullAIMsg.tool_calls ?? [];

      // 没有要调用的工具，直接把回答返回给调用方
      if (!toolCalls.length) {
        return;
      }

      // 依次执行本轮需要调用的所有工具
      for (const toolCall of toolCalls) {
        const tool = this.tools.find((t) => t.name === toolCall.name);

        if (!tool) {
          continue;
        }

        console.log('调用工具:', toolCall.name, toolCall.args);
        const result = await tool.invoke(toolCall.args);
        console.log('调用工具结果:', toolCall.name, result);

        history.addMessage(
          new ToolMessage({
            tool_call_id: toolCall.id || '',
            name: toolCall.name,
            content: result,
          }),
        );
      }
    }
  }

  async agentStream(messages: UIMessage[]) {
    // 转为 langchain 消息格式
    const lcMessages = await toBaseMessages(messages);
    const lgStream = await this.agent.stream(
      { messages: lcMessages },
      {
        streamMode: ['messages', 'values'],
        recursionLimit: 12,
      },
    );

    // 转为 ui 消息格式
    return toUIMessageStream(lgStream as AsyncIterable<AIMessageChunk>);
  }
}
