import {
  Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards,
} from '@nestjs/common';
import type { ConsentScope, SpeakerDto } from '@dialect/shared';
import { AuthGuard, JwtPayload } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { MapperService } from './mapper.service';
import { SpeakersService } from './speakers.service';

@Controller('speakers')
@UseGuards(AuthGuard)
export class SpeakersController {
  constructor(
    private readonly service: SpeakersService,
    private readonly mapper: MapperService,
  ) {}

  @Get()
  async list() {
    return (await this.service.list()).map((s) => this.mapper.speaker(s));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.mapper.speaker(await this.service.get(id));
  }

  @Post()
  @Roles('investigator', 'admin')
  async create(@Body() dto: SpeakerDto, @Req() req: { user: JwtPayload }) {
    return this.mapper.speaker(await this.service.upsert(dto, req.user.deviceId));
  }

  @Put(':id')
  @Roles('investigator', 'admin')
  async update(@Param('id') id: string, @Body() dto: SpeakerDto, @Req() req: { user: JwtPayload }) {
    return this.mapper.speaker(await this.service.upsert({ ...dto, id }, req.user.deviceId));
  }

  @Delete(':id')
  @Roles('investigator', 'admin')
  async remove(@Param('id') id: string) {
    await this.service.softDelete(id);
    return { ok: true };
  }

  @Post(':id/consent')
  @Roles('investigator', 'admin')
  grant(
    @Param('id') id: string,
    @Body() body: { scope: ConsentScope; agreementText: string; signedAt?: string },
  ) {
    return this.service.grantConsent(id, body);
  }

  @Post(':id/revoke')
  @Roles('investigator', 'admin')
  revoke(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    return this.service.revokeConsent(id, req.user);
  }
}
