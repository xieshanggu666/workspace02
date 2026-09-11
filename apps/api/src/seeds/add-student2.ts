import '../ensure-env';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { ALL_ENTITIES, User } from '../entities';

(async () => {
  const ds = new DataSource({
    type: 'sqljs',
    location: process.env.SQLITE_FILE || './dialect-demo.sqlite',
    autoSave: true,
    synchronize: true,
    entities: ALL_ENTITIES,
  });
  await ds.initialize();
  const repo = ds.getRepository(User);
  const hash = await bcrypt.hash('demo1234', 10);
  const exists = await repo.findOneBy({ username: 'student2' });
  if (!exists) {
    await repo.save(
      repo.create({
        id: 'usr-student-02', username: 'student2', displayName: '学员小吴',
        role: 'student', passwordHash: hash, version: 1,
      } as unknown as User),
    );
    console.log('student2 created');
  } else {
    console.log('student2 exists');
  }
  await ds.destroy();
})();
