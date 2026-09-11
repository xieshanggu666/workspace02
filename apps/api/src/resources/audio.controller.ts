import {
  Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res,
  UploadedFile, UseGuards, UseInterceptors, ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { AudioAssetDto } from '@dialect/shared';
import { AuthGuard, JwtPayload } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { MapperService } from './mapper.service';
import { AudioService } from './audio.service';

@Controller('audio')
@UseGuards(AuthGuard)
export class AudioController {
  constructor(
    private readonly service: AudioService,
    private readonly mapper: MapperService,
  ) {}

  @Get()
  async list(
    @Req() req: { user: JwtPayload },
    @Query('dialect') dialect?: string,
    @Query('speakerId') speakerId?: string,
  ) {
    // 列表按知情同意范围过滤：staff 见全部；教练/学员只见 course/public
    const staff = ['investigator', 'admin'].includes(req.user.role);
    const rows = await this.service.list({
      dialect,
      speakerId,
      includeRestricted: staff,
      role: req.user.role,
    });
    return rows.map((a) => this.mapper.audio(a));
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    // 单条元数据同样执行同意范围闸门（research 对教练/学员不可见）
    return this.service.getDto(id, req.user.role);
  }

  @Post()
  @Roles('investigator', 'admin')
  async create(@Body() dto: AudioAssetDto, @Req() req: { user: JwtPayload }) {
    return this.mapper.audio(
      await this.service.upsert(dto, req.user.deviceId, { role: req.user.role, userId: req.user.sub }),
    );
  }

  @Put(':id')
  @Roles('investigator', 'coach', 'admin')
  async update(@Param('id') id: string, @Body() dto: AudioAssetDto, @Req() req: { user: JwtPayload }) {
    // 可写字段的角色边界由 service.upsert 统一强制执行
    // （教练只能改标注层；filePath/keyVersion 任何客户端都不可写）
    return this.mapper.audio(
      await this.service.upsert(
        { ...dto, id },
        req.user.deviceId,
        { role: req.user.role, userId: req.user.sub },
      ),
    );
  }

  @Delete(':id')
  @Roles('investigator', 'admin')
  async remove(@Param('id') id: string) {
    await this.service.softDelete(id);
    return { ok: true };
  }

  /** 上传/替换录音二进制（multipart 字段名 file）。敏感录音自动加密落盘。 */
  @Post(':id/file')
  @Roles('investigator', 'admin')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new ForbiddenException('缺少 file 字段');
    return this.mapper.audio(
      await this.service.attachFile(id, file.buffer, file.mimetype),
    );
  }

  /** 下载录音；受限资源在内存解密，并做角色/授权闸门校验 */
  @Get(':id/file')
  async download(
    @Param('id') id: string,
    @Req() req: { user: JwtPayload },
    @Res() res: Response,
  ) {
    const { mime, data } = await this.service.readMedia(id, req.user.role);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    res.send(data);
  }
}
