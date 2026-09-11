import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Course, CourseItem } from '../entities';
import type { CourseDto } from '@dialect/shared';
import { MapperService } from './mapper.service';

@Injectable()
export class CoursesService {
  constructor(
    @InjectRepository(Course) private readonly courses: Repository<Course>,
    @InjectRepository(CourseItem) private readonly items: Repository<CourseItem>,
    private readonly mapper: MapperService,
  ) {}

  async list(publishedOnly = false): Promise<CourseDto[]> {
    const rows = await this.courses.find({
      where: { ...(publishedOnly ? { published: true } : {}) },
      order: { updatedAt: 'DESC' },
    });
    const allItems = await this.items.findBy({ deletedAt: IsNull() });
    return rows
      .filter((c) => !c.deletedAt)
      .map((c) =>
        this.mapper.course(c, allItems.filter((i) => i.courseId === c.id)),
      );
  }

  async getEntity(id: string): Promise<Course> {
    const c = await this.courses.findOneBy({ id });
    if (!c || c.deletedAt) throw new NotFoundException('课程不存在');
    return c;
  }

  async getDto(id: string): Promise<CourseDto> {
    const c = await this.getEntity(id);
    const items = await this.items.findBy({ courseId: id, deletedAt: IsNull() });
    return this.mapper.course(c, items);
  }

  /**
   * 整课保存（编排页一次提交）：服务端对条目做 upsert 对账。
   * 客户端离线期间重排顺序也能正确合并：以提交的 items 为准，
   * 库中多余的条目软删除。
   */
  async saveCourse(dto: CourseDto, deviceId?: string): Promise<CourseDto> {
    let course = await this.courses.findOneBy({ id: dto.id });
    if (!course) {
      course = this.courses.create({ id: dto.id, itemIds: [] });
      course.version = Math.max(1, dto.version);
    } else {
      course.version += 1;
    }
    Object.assign(course, {
      title: dto.title,
      description: dto.description ?? null,
      coachId: dto.coachId,
      dialect: dto.dialect,
      published: dto.published,
      itemIds: (dto.items || []).map((i) => i.id),
      deviceId: deviceId ?? dto.deviceId ?? course.deviceId,
    });
    course.updatedAt = new Date() as any;
    await this.courses.save(course);

    const incomingIds = new Set<string>();
    for (const itemDto of dto.items || []) {
      incomingIds.add(itemDto.id);
      let item = await this.items.findOneBy({ id: itemDto.id });
      if (!item) {
        item = this.items.create({ id: itemDto.id, version: Math.max(1, itemDto.version) });
      } else {
        item.version += 1;
      }
      Object.assign(item, {
        courseId: course.id,
        audioId: itemDto.audioId,
        orderIndex: itemDto.orderIndex,
        repeatTimes: itemDto.repeatTimes ?? 3,
        coachTip: itemDto.coachTip ?? null,
        deviceId: deviceId ?? itemDto.deviceId ?? item.deviceId,
      });
      item.updatedAt = new Date() as any;
      await this.items.save(item);
    }

    // 课程中被移除的条目
    const existing = await this.items.findBy({ courseId: course.id });
    for (const stale of existing) {
      if (!incomingIds.has(stale.id) && !stale.deletedAt) {
        stale.deletedAt = new Date();
        stale.updatedAt = new Date() as any;
        await this.items.save(stale);
      }
    }

    return this.getDto(course.id);
  }

  async publish(id: string, published: boolean): Promise<CourseDto> {
    const c = await this.getEntity(id);
    c.published = published;
    c.version += 1;
    c.updatedAt = new Date() as any;
    await this.courses.save(c);
    return this.getDto(id);
  }

  async softDelete(id: string): Promise<void> {
    await this.courses.update(id, { deletedAt: new Date(), updatedAt: new Date() as any });
  }
}
