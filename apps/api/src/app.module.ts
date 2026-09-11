import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { appConfig } from './config/configuration';
import { buildDataSourceOptions } from './config/data-source.factory';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';
import { ResourcesModule } from './resources/resources.module';
import { SyncModule } from './sync/sync.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: ['.env', '../../.env'],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildDataSourceOptions(config.get('app.db') as any),
    }),
    AuthModule,
    ResourcesModule,
    SyncModule,
  ],
})
export class AppModule {}
