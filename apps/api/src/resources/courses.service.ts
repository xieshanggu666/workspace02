import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Course, CourseItem, AudioAsset, Speaker } from '../entities';
import type { CourseDto } from '@dialect/shared';
import { canUseInCourse } from '@dialect/shared';
import { MapperService } from './mapper.service';

@Injectable()
export class CoursesService {
  constructor(
    @InjectRepository(Course) private readonly courses: Repository<Course>,
    @InjectRepository(CourseItem) private readonly items: Repository<CourseItem>,
    @InjectRepository(AudioAsset) private readonly assets: Repository<AudioAsset>,
    @InjectRepository(Speaker) private readonly speakers: Repository<Speaker>,
    private readonly mapper: MapperService,
  ) {}

  /**
   * 校验课程引用的全部素材是否都允许用于课程。
   * research/pending/revoked 的素材一律拒绝编入学员可见课程
   * （扩大使用范围必须先重新取得 course/public 授权）。
   */
  private async assertItemsUsable(audioIds: string[]): Promise<void> {
    const uniq = Array.from(new Set(audioIds));
    if (uniq.length === 0) return;
    const assets = await this.assets.findBy({ id: In(uniq) });
    const speakers = await this.speakers.findBy({
      id: In(Array.from(new Set(assets.map((a) => a.speakerId)))),
    });
    const spkById = new Map(speakers.map((s) => [s.id, s]));

    for (const a of assets) {
      const spk = spkById.get(a.speakerId);
      if (!canUseInCourse({ consentStatus: spk?.consentStatus, consentScope: spk?.consentScope }, 'coach')) {
        throw new ForbiddenException(
          `素材「${a.title}」的授权范围为${
            spk?.consentStatus === 'granted' ? `「${spk.consentScope}」` : `未完成（${spk?.consentStatus || '无说话人'}）`
          }，不能编入跟读课；如需课程用途请先取得 course/public 授权`,
        );
      }
    }
    const missing = uniq.filter((id) => !assets.some((a) => a.id === id));
    if (missing.length) throw new BadRequestException(`引用的素材不存在: ${missing.join(', ')}`);
  }

  async list(publishedOnly = false, role: 'investigator' | 'coach' | 'student' | 'admin' | 'speaker' = 'coach'): Promise<CourseDto[]> {
    const rows = await this.courses.find({
      where: { ...(publishedOnly ? { published: true } : {}) },
      order: { updatedAt: 'DESC' },
    });
    const allItems = await this.items.findBy({ deletedAt: IsNull() });
    const dtos = rows
      .filter((c) => !c.deletedAt)
      .map((c) => this.mapper.course(c, allItems.filter((i) => i.courseId === c.id)));
    // 学员视角：整课以及其中每个引用都必须在课程授权范围内（纵深防御历史/绕过数据）
    if (role === 'student') {
      const allowed = await this.allowedAudioIdsForStudent();
      return dtos
        .map((c) => ({ ...c, items: c.items.filter((i) => allowed.has(i.audioId)) }))
        .filter((c) => c.items.length > 0);
    }
    return dtos;
  }

  private async allowedAudioIdsForStudent(): Promise<Set<string>> {
    const assets = await this.assets.find();
    const speakers = await this.speakers.findBy({
      id: In(Array.from(new Set(assets.map((a) => a.speakerId)))),
    });
    const spk = new Map(speakers.map((s) => [s.id, s]));
    return new Set(
      assets
        .filter((a) =>
          // 分发只看授权；撤回封口后若重新获得 course/public，即使文件仍加密也恢复可用
          canUseInCourse(
            {
              consentStatus: spk.get(a.speakerId)?.consentStatus,
              consentScope: spk.get(a.speakerId)?.consentScope,
            },
            'coach',
          ),
        )
        .map((a) => a.id),
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

  /** 学员视角：过滤掉引用越界素材的课目；全越界时 403 */
  async getDtoForStudent(id: string): Promise<CourseDto> {
    const dto = await this.getDto(id);
    const allowed = await this.allowedAudioIdsForStudent();
    const items = dto.items.filter((i) => allowed.has(i.audioId));
    if (items.length === 0) {
      throw new ForbiddenException('该课程含超出授权范围的素材');
    }
    return { ...dto, items };
  }

  /**
   * 整课保存（编排页一次提交）：服务端对条目做 upsert 对账。
   * 客户端离线期间重排顺序也能正确合并：以提交的 items 为准，
   * 库中多余的条目软删除。
   */
  async saveCourse(dto: CourseDto, deviceId?: string): Promise<CourseDto> {
    // 先校验引用素材的授权范围，拒绝后不产生任何半截写入
    await this.assertItemsUsable((dto.items || []).map((i) => i.audioId));

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
    if (published) {
      // 发布前复检：草稿期间授权可能已被撤回或收窄
      const items = await this.items.findBy({ courseId: id, deletedAt: IsNull() });
      await this.assertItemsUsable(items.map((i) => i.audioId));
    }
    c.published = published;
    c.version += 1;
    c.updatedAt = new Date() as any;
    await this.courses.save(c);
    return this.getDto(id);
  }

  async softDelete(id: string): Promise<void> {
    await this.courses.update(id, { deletedAt: new Date(), updatedAt: new Date() as any, serverUpdatedAt: new Date() });
  }
}
