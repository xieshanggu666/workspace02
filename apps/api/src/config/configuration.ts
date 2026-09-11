import { registerAs } from '@nestjs/config';

/**
 * 数据库配置：
 *  - 生产/开发默认 MySQL（账号 root / 密码 zhongxin123）
 *  - DB_TYPE=sqlite 时使用本地文件（sql.js 驱动，便于无 MySQL 环境演示/测试）
 */
export const appConfig = registerAs('app', () => {
  const dbType = process.env.DB_TYPE === 'sqlite' ? 'sqlite' : 'mysql';
  return {
    port: parseInt(process.env.API_PORT || '3000', 10),
    jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
    masterKeyHex:
      process.env.MEDIA_MASTER_KEY_HEX ||
      '4f8b2d6c1e9a7f3056d4c2b8a19f7e6d3c0b9a8f7e6d5c4b3a291807f6e5d4c3',
    uploadDir: process.env.UPLOAD_DIR || `${process.cwd()}/uploads`,
    db: {
      type: dbType,
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'zhongxin123',
      name: process.env.DB_NAME || 'dialect',
      synchronize: (process.env.DB_SYNCHRONIZE || 'true') === 'true',
      sqliteFile: process.env.SQLITE_FILE || `${process.cwd()}/dialect-demo.sqlite`,
    },
  };
});

export type AppConfig = ReturnType<typeof appConfig>;
