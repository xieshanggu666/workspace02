import { Injectable } from '@nestjs/common';
import { Speaker, AudioAsset, Course, CourseItem, PracticeAttempt, Annotation, User } from '../entities';
import type {
  SpeakerDto,
  AudioAssetDto,
  CourseDto,
  CourseItemDto,
  PracticeAttemptDto,
  AnnotationDto,
  UserDto,
} from '@dialect/shared';

const iso = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

@Injectable()
export class MapperService {
  user(u: User): UserDto {
    return {
      id: u.id, username: u.username, displayName: u.displayName, role: u.role,
      version: u.version, deviceId: u.deviceId, updatedAt: u.updatedAt, deletedAt: iso(u.deletedAt),
    };
  }

  speaker(s: Speaker): SpeakerDto {
    return {
      id: s.id, code: s.code, name: s.name, gender: s.gender, birthYear: s.birthYear,
      dialect: s.dialect, region: s.region, consentStatus: s.consentStatus,
      consentScope: s.consentScope, consentSignedAt: iso(s.consentSignedAt),
      consentHash: s.consentHash, notes: s.notes,
      version: s.version, deviceId: s.deviceId, updatedAt: s.updatedAt, deletedAt: iso(s.deletedAt),
    };
  }

  audio(a: AudioAsset): AudioAssetDto {
    return {
      id: a.id, title: a.title, speakerId: a.speakerId, ownerId: a.ownerId,
      dialect: a.dialect, filePath: a.filePath, durationSec: a.durationSec,
      sampleRate: a.sampleRate, channels: a.channels, mime: a.mime,
      waveformPeaks: a.waveformPeaks || [], transcript: a.transcript, translation: a.translation,
      ipa: a.ipa, syllables: a.syllables || [], status: a.status, sensitive: a.sensitive,
      recordedAt: iso(a.recordedAt)!, keyVersion: a.keyVersion,
      version: a.version, deviceId: a.deviceId, updatedAt: a.updatedAt, deletedAt: iso(a.deletedAt),
    };
  }

  course(c: Course, items: CourseItem[] = []): CourseDto {
    return {
      id: c.id, title: c.title, description: c.description, coachId: c.coachId,
      dialect: c.dialect, published: c.published,
      items: items.sort((a, b) => a.orderIndex - b.orderIndex).map((i) => this.courseItem(i)),
      version: c.version, deviceId: c.deviceId, updatedAt: c.updatedAt, deletedAt: iso(c.deletedAt),
    };
  }

  courseItem(i: CourseItem): CourseItemDto {
    return {
      id: i.id, courseId: i.courseId, audioId: i.audioId, orderIndex: i.orderIndex,
      repeatTimes: i.repeatTimes, coachTip: i.coachTip,
      version: i.version, deviceId: i.deviceId, updatedAt: i.updatedAt, deletedAt: iso(i.deletedAt),
    };
  }

  attempt(a: PracticeAttempt): PracticeAttemptDto {
    return {
      id: a.id, studentId: a.studentId, courseItemId: a.courseItemId, audioId: a.audioId,
      filePath: a.filePath, durationSec: a.durationSec, waveformPeaks: a.waveformPeaks || [],
      score: a.score, createdAt: iso(a.createdAt)!,
      version: a.version, deviceId: a.deviceId, updatedAt: a.updatedAt, deletedAt: iso(a.deletedAt),
    };
  }

  annotation(a: Annotation): AnnotationDto {
    return {
      id: a.id, attemptId: a.attemptId, coachId: a.coachId, atSec: a.atSec,
      comment: a.comment, rating: a.rating,
      version: a.version, deviceId: a.deviceId, updatedAt: a.updatedAt, deletedAt: iso(a.deletedAt),
    };
  }
}
