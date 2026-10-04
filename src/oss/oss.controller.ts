import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Delete,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OssService } from './oss.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@Controller('oss')
export class OssController {
  constructor(private readonly ossService: OssService) {}

  /** 上传文件到 OSS 并记录到数据库 */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file, @CurrentUser() user: AuthenticatedUser) {
    // multer 用 latin1 解码文件名，中文会乱码，需要重新按 utf8 解码
    const originalName = Buffer.from(file.originalname, 'latin1').toString(
      'utf8',
    );
    return this.ossService.uploadFile(
      originalName,
      file.buffer,
      file.mimetype,
      user.id,
    );
  }

  /** 分页查询文件记录 */
  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.ossService.findAll(
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 10,
      user.id,
    );
  }

  /** 查询单条文件记录 */
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ossService.findOne(id, user.id);
  }

  /** 删除文件记录 */
  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ossService.remove(id, user.id);
  }
}
