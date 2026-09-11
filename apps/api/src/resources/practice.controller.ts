import {
  Body, Controller, Get, Param, Post, Query, Req, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { AnnotationDto, PracticeAttemptDto } from '@dialect/shared';
import { AuthGuard, JwtPayload } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { MapperService } from './mapper.service';
import { PracticeService } from './practice.service';

@Controller('practice')
@UseGuards(AuthGuard)
export class PracticeController {
  constructor(
    private readonly service: PracticeService,
    private readonly mapper: MapperService,
  ) {}

  /** 学员：我的练习；教练：全部 */
  @Get('attempts')
  async attempts(@Req() req: { user: JwtPayload }) {
    if (req.user.role === 'coach' || req.user.role === 'admin') {
      return this.service.listForCoach();
    }
    const rows = await this.service.listAttempts(
      req.user.role === 'student' ? req.user.sub : undefined,
    );
    return rows.map((a) => this.mapper.attempt(a));
  }

  @Post('attempts')
  @Roles('student', 'admin')
  async submit(@Body() dto: PracticeAttemptDto, @Req() req: { user: JwtPayload }) {
    const saved = await this.service.submitAttempt(
      { ...dto, studentId: req.user.sub },
      req.user.deviceId,
    );
    return this.mapper.attempt(saved);
  }

  @Post('attempts/:id/file')
  @Roles('student', 'admin')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAttempt(@Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new Error('缺少 file 字段');
    return this.mapper.attempt(await this.service.attachAttemptFile(id, file.buffer));
  }

  @Get('attempts/:id/file')
  async downloadAttempt(
    @Param('id') id: string,
    @Req() req: { user: JwtPayload },
    @Res() res: Response,
  ) {
    const { mime, data } = await this.service.readAttemptFile(id, req.user.role, req.user.sub);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    res.send(data);
  }

  @Get('attempts/:id/annotations')
  async annotations(@Param('id') id: string) {
    return (await this.service.listAnnotations(id)).map((a) => this.mapper.annotation(a));
  }

  @Post('attempts/:id/annotations')
  @Roles('coach', 'admin')
  async annotate(
    @Param('id') id: string,
    @Body() dto: Omit<AnnotationDto, 'attemptId' | 'coachId'> & { comment: string; atSec: number },
    @Req() req: { user: JwtPayload },
  ) {
    const full: AnnotationDto = {
      ...(dto as AnnotationDto),
      id: (dto as any).id,
      attemptId: id,
      coachId: req.user.sub,
    };
    const saved = await this.service.addAnnotation(full, req.user.sub, req.user.deviceId);
    return this.mapper.annotation(saved);
  }
}
