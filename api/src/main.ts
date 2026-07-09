import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.webOrigin, credentials: true });
  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`Tech Lingua CRM API listening on :${config.port}`);
}
bootstrap();
