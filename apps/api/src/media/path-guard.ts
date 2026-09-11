import * as path from 'path';

/**
 * 媒体存储路径安全守卫。
 *
 * 背景：filePath 必须永远由服务端生成（upload/attachFile），客户端只能
 * 通过专门的 multipart 接口提交文件内容。历史上 filePath/keyVersion 可被
 * 普通编辑接口（如教练 PUT /audio/:id）改写，配合 path.join 的越界特性
 * （path.join('/srv/uploads', '../../etc/passwd') → '/etc/passwd'）可读到
 * API 进程权限内的任意文件（配置、源码、密钥）。
 *
 * 这里做纵深防御：即使 filePath 以某种方式被污染，读取时也会被挡在存储根目录内。
 */

/**
 * 服务端生成的媒体相对路径白名单：
 *   audio/<id>.<wav|m4a>[.enc]
 *   attempts/<id>.<wav|m4a>.enc
 * id 只允许 [A-Za-z0-9_-]
 */
const SAFE_MEDIA_RE =
  /^(?:audio|attempts)\/[A-Za-z0-9_-]+\.(?:wav|m4a)(?:\.enc)?$/;

export function isSafeMediaRelativePath(rel: string | null | undefined): boolean {
  return !!rel && SAFE_MEDIA_RE.test(rel);
}

/**
 * 把相对路径解析为存储根目录下的绝对路径，并确保结果不会逃逸。
 * 任何绝对路径、.. 穿越、符号链接外跳（此处做词法校验）都会抛错。
 */
export function resolveWithinStorage(rootDir: string, rel: string): string {
  if (!isSafeMediaRelativePath(rel)) {
    throw new Error(`非法媒体路径: ${rel}`);
  }
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, rel);
  const relFromRoot = path.relative(root, abs);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new Error(`媒体路径越界: ${rel}`);
  }
  return abs;
}
