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
    // 学员看不到 restricted；调查员/教练可以
    const trusted = ['investigator', 'coach', 'admin'].includes(req.user.role);
    const rows = await this.service.list({ dialect, speakerId, includeRestricted: trusted });
    return rows.map((a) => this.mapper.audio(a));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.mapper.audio(await this.service.getEntity(id));
  }

  @Post()
  @Roles('investigator', 'admin')
  async create(@Body() dto: AudioAssetDto, @Req() req: { user: JwtPayload }) {
    return this.mapper.audio(await this.service.upsert(dto, req.user.deviceId));
  }

  @Put(':id')
  @Roles('investigator', 'coach', 'admin')
  async update(@Param('id') id: string, @Body() dto: AudioAssetDto, @Req() req: { user: JwtPayload }) {
    // 教练只允许改标注层（音节/转写/状态），所有权字段不可改
    if (req.user.role === 'coach') {
      const existing = await this.service.getEntity(id);
      dto.ownerId = existing.ownerId;
      dto.speakerId = existing.speakerId;
      dto.sensitive = existing.sensitive;
    }
    return this.mapper.audio(await this.service.upsert({ ...dto, id }, req.user.deviceId));
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
    return this.mapper.audio(await this.service.attachFile(id, file.buffer));
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
