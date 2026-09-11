import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ALL_ENTITIES } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { MapperService } from './mapper.service';
import { SpeakersService } from './speakers.service';
import { SpeakersController } from './speakers.controller';
import { AudioService } from './audio.service';
import { AudioController } from './audio.controller';
import { CoursesService } from './courses.service';
import { CoursesController } from './courses.controller';
import { PracticeService } from './practice.service';
import { PracticeController } from './practice.controller';

@Module({
  imports: [TypeOrmModule.forFeature(ALL_ENTITIES), AuthModule],
  controllers: [SpeakersController, AudioController, CoursesController, PracticeController],
  providers: [MapperService, SpeakersService, AudioService, CoursesService, PracticeService],
  exports: [MapperService, SpeakersService, AudioService, CoursesService, PracticeService, TypeOrmModule],
})
export class ResourcesModule {}
