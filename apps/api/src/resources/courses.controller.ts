import {
  Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import type { CourseDto } from '@dialect/shared';
import { AuthGuard, JwtPayload } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { CoursesService } from './courses.service';

@Controller('courses')
@UseGuards(AuthGuard)
export class CoursesController {
  constructor(private readonly service: CoursesService) {}

  @Get()
  list(@Req() req: { user: JwtPayload }, @Query('published') published?: string) {
    // 学员端只看已发布；教练/调查员看全部
    const only = req.user.role === 'student' ? true : published === 'true';
    return this.service.list(only);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getDto(id);
  }

  @Post()
  @Roles('coach', 'admin')
  create(@Body() dto: CourseDto, @Req() req: { user: JwtPayload }) {
    return this.service.saveCourse({ ...dto, coachId: dto.coachId || req.user.sub }, req.user.deviceId);
  }

  @Put(':id')
  @Roles('coach', 'admin')
  update(@Param('id') id: string, @Body() dto: CourseDto, @Req() req: { user: JwtPayload }) {
    return this.service.saveCourse({ ...dto, id }, req.user.deviceId);
  }

  @Post(':id/publish')
  @Roles('coach', 'admin')
  publish(@Param('id') id: string, @Body() body: { published: boolean }) {
    return this.service.publish(id, !!body.published);
  }

  @Delete(':id')
  @Roles('coach', 'admin')
  async remove(@Param('id') id: string) {
    await this.service.softDelete(id);
    return { ok: true };
  }
}
