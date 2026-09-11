import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { SyncPushPayload, SyncPullResult, SyncPushResult } from '@dialect/shared';
import { AuthGuard, JwtPayload } from '../auth/auth.guard';
import { SyncService } from './sync.service';

@Controller('sync')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(private readonly service: SyncService) {}

  @Get('pull')
  pull(
    @Req() req: { user: JwtPayload },
    @Query('cursor') cursor?: string,
  ): Promise<SyncPullResult> {
    return this.service.pull(cursor, req.user.role, req.user.sub);
  }

  @Post('push')
  push(
    @Req() req: { user: JwtPayload },
    @Body() payload: SyncPushPayload,
  ): Promise<SyncPushResult> {
    return this.service.push(payload, req.user.role, req.user.sub);
  }
}
