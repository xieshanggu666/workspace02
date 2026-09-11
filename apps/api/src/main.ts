import './ensure-env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { bootstrapAttemptCrypto } from './resources/attempt-crypto';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
  app.enableCors({ origin: true });

  const config = app.get(ConfigService);
  bootstrapAttemptCrypto(config);
  const port = config.get<number>('app.port')!;
  const dbType = config.get<string>('app.db.type')!;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`方言调查 API 已启动: http://127.0.0.1:${port}/api  (db=${dbType})`);
  logger.log(`健康检查: GET http://127.0.0.1:${port}/api/health`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('启动失败：', err);
  process.exit(1);
});
