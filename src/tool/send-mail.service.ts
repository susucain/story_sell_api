import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerService } from '@nestjs-modules/mailer';
import { z } from 'zod';
import { tool, StructuredTool } from '@langchain/core/tools';

@Injectable()
export class SendMailService {
  readonly tool: StructuredTool;

  constructor(configService: ConfigService, mailerService: MailerService) {
    const sendMailArgsSchema = z.object({
      to: z.string().describe('收件人邮箱，例如: user@example.com'),
      subject: z.string().describe('邮件主题，例如: 你好'),
      text: z.string().describe('邮件内容，例如: 你好'),
      html: z.string().describe('邮件内容，例如: <h1>你好</h1>'),
    });

    this.tool = tool(
      async ({
        to,
        subject,
        text,
        html,
      }: z.infer<typeof sendMailArgsSchema>) => {
        const fallbackFrom = configService.get<string>('MAIL_FROM');
        try {
          await mailerService.sendMail({
            to,
            subject,
            text: text ?? '（无文本内容）',
            html: html ?? `<p>${text ?? '（无 HTML 内容）'}</p>`,
            from: fallbackFrom,
          });
        } catch (error) {
          return `发送邮件失败: ${error.message}`;
        }
        return `邮件已发送到 ${to}, 主题为「${subject}」`;
      },
      {
        name: 'send_mail',
        description: '发送邮件。输入收件人邮箱、主题和 HTML 内容，发送邮件。',
        schema: sendMailArgsSchema,
      },
    );
  }
}
