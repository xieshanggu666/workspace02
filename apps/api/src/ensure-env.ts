// 必须在任何实体被导入（装饰器求值）之前执行：
// 根据 .env / 环境变量决定 datetime 列的方言形态。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require('dotenv');
config();
config({ path: '../../.env' });
