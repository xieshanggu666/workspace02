import {
  BadRequestException, Body, Controller, Get, Param, Post, Req, Res,
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

  /** 学员：仅本人练习；教练/管理员：全部待批注 */
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
    // 学员的归属身份强制取登录 token，请求体里的 studentId 不可信
    const saved = await this.service.submitAttempt(
      dto,
      req.user.role === 'student' ? req.user.sub : dto.studentId,
      req.user.deviceId,
    );
    return this.mapper.attempt(saved);
  }

  /**
   * 上传跟读录音。学员只能给本人 attempt 上传（归属校验在 service 内，
   * 持有他人 attempt id 也会被 403 拒绝，无法覆盖对方录音）。
   */
  @Post('attempts/:id/file')
  @Roles('student')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAttempt(
    @Param('id') id: string,
    @Req() req: { user: JwtPayload },
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('缺少 file 字段');
    return this.mapper.attempt(
      await this.service.attachAttemptFile(id, file.buffer, req.user.sub),
    );
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

  /** 批注列表：学员只能看本人 attempt；教练可看任意 */
  @Get('attempts/:id/annotations')
  async annotations(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    const rows = await this.service.listAnnotations(id, req.user.role, req.user.sub);
    return rows.map((a) => this.mapper.annotation(a));
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
