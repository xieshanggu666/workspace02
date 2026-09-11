/** 测试用内存 AsyncStorage 桩 */
const mem = new Map<string, string>();

export default {
  getItem: jestSafe((key: string) => Promise.resolve(mem.has(key) ? mem.get(key)! : null)),
  setItem: jestSafe((key: string, value: string) => {
    mem.set(key, value);
    return Promise.resolve();
  }),
  removeItem: jestSafe((key: string) => {
    mem.delete(key);
    return Promise.resolve();
  }),
  clear: jestSafe(() => {
    mem.clear();
    return Promise.resolve();
  }),
};

function jestSafe<T extends (...args: any[]) => any>(fn: T): T {
  return fn;
}
