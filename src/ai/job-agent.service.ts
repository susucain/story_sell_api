import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { Runnable } from '@langchain/core/runnables';
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { StructuredTool } from '@langchain/core/tools';

@Injectable()
export class JobAgentService {
  private readonly logger = new Logger(JobAgentService.name);
  private readonly modelWithTools: Runnable<BaseMessage[], AIMessage>;
  private readonly tools: StructuredTool[];

  constructor(
    @Inject('CHAT_MODEL') model: ChatOpenAI,
    @Inject('SEND_MAIL_TOOL') private readonly sendMailTool: StructuredTool,
    @Inject('WEB_SEARCH_TOOL') private readonly webSearchTool: StructuredTool,
    @Inject('DB_USERS_CRUD_TOOL')
    private readonly dbUsersCrudTool: StructuredTool,
    @Inject('TIME_NOW_TOOL') private readonly timeNowTool: StructuredTool,
  ) {
    this.modelWithTools = model.bindTools([
      this.sendMailTool,
      this.webSearchTool,
      this.dbUsersCrudTool,
      this.timeNowTool,
    ]);

    this.tools = [
      this.sendMailTool,
      this.webSearchTool,
      this.dbUsersCrudTool,
      this.timeNowTool,
    ];
  }

  async runJob(instruction: string): Promise<string> {
    const history = new InMemoryChatMessageHistory();

    history.addMessages([
      new SystemMessage(
        '你是一个用于执行后台任务的智能代理。你会根据给定的任务指令，必要时调用工具（如 db_users_crud、send_mail、web_search、time_now 等）来查询或改写数据，然后给出清晰的步骤和结果说明。',
      ),
      new HumanMessage(instruction),
    ]);

    while (true) {
      const messages = await history.getMessages();
      const aiMessage = await this.modelWithTools.invoke(messages);
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
          this.logger.warn(`未知工具调用: ${toolCall.name}`);
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
}
