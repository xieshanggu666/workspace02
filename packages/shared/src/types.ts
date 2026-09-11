/**
 * 共享领域类型 —— 后端 NestJS 与移动端 React Native 同时引用，
 * 保证离线同步的字段结构一致。
 */

/** 同步实体均带有的版本字段 */
export interface Syncable {
  id: string;
  /** 单调递增版本号；服务端更新成功才 +1 */
  version: number;
  /** 最近一次产生变更的设备标识 */
  deviceId?: string | null;
  updatedAt: string;
  deletedAt?: string | null;
}

export type UserRole = 'investigator' | 'speaker' | 'coach' | 'student' | 'admin';

export interface UserDto extends Syncable {
  username: string;
  displayName: string;
  role: UserRole;
}

export type ConsentScope = 'research' | 'course' | 'public';
export type ConsentStatus = 'granted' | 'revoked' | 'pending';

export interface SpeakerDto extends Syncable {
  code: string;
  name: string;
  gender?: 'M' | 'F' | 'O' | null;
  birthYear?: number | null;
  dialect: string;
  region: string;
  consentStatus: ConsentStatus;
  consentScope?: ConsentScope | null;
  consentSignedAt?: string | null;
  /** 授权协议文本哈希，防事后篡改 */
  consentHash?: string | null;
  notes?: string | null;
}

export type AudioStatus = 'draft' | 'annotated' | 'published' | 'restricted';

export interface SyllableMark {
  /** 在整段音频中的起始秒 */
  start: number;
  /** 结束秒 */
  end: number;
  /** 音节/词的方言转写（可含 IPA） */
  label: string;
  /** 普通话对译 */
  gloss?: string;
}

export interface AudioAssetDto extends Syncable {
  title: string;
  speakerId: string;
  /** 采集调查员 id */
  ownerId: string;
  dialect: string;
  filePath?: string | null;
  durationSec: number;
  sampleRate: number;
  channels: number;
  mime: string;
  /** 录音时从声级计采样得到的波形峰值 (0..1)，用于离线波形渲染 */
  waveformPeaks: number[];
  /** 整句转写 */
  transcript?: string | null;
  translation?: string | null;
  ipa?: string | null;
  syllables: SyllableMark[];
  status: AudioStatus;
  /** 录音敏感级别；restricted 资源服务端加密落盘 */
  sensitive: boolean;
  recordedAt: string;
  /** 媒体加密密钥版本（null = 未加密） */
  keyVersion?: number | null;
}

export interface CourseDto extends Syncable {
  title: string;
  description?: string | null;
  coachId: string;
  dialect: string;
  published: boolean;
  items: CourseItemDto[];
}

export interface CourseItemDto extends Syncable {
  courseId: string;
  audioId: string;
  orderIndex: number;
  /** 跟读要求：听原音后模仿的次数 */
  repeatTimes: number;
  coachTip?: string | null;
}

export interface PracticeAttemptDto extends Syncable {
  studentId: string;
  courseItemId: string;
  audioId: string;
  filePath?: string | null;
  durationSec: number;
  /** 跟读录音格式：iOS audio/wav、Android audio/mp4(m4a) */
  mime?: string | null;
  waveformPeaks: number[];
  /** 0..100，可由后续语音对齐模块填充 */
  score?: number | null;
  createdAt: string;
}

export interface AnnotationDto extends Syncable {
  attemptId: string;
  coachId: string;
  /** 批注出现的时间点（秒） */
  atSec: number;
  comment: string;
  rating?: number | null;
}

/* ============ 认证 / 同步传输对象 ============ */

export interface LoginRequest {
  username: string;
  password: string;
  deviceId?: string;
}

export interface LoginResponse {
  token: string;
  user: UserDto;
}

/** 客户端 -> 服务端的一次推送，按实体类型分桶 */
export interface SyncPushPayload {
  deviceId: string;
  users?: SyncEnvelope<UserDto>[];
  speakers?: SyncEnvelope<SpeakerDto>[];
  audio?: SyncEnvelope<AudioAssetDto>[];
  courses?: SyncEnvelope<CourseDto>[];
  courseItems?: SyncEnvelope<CourseItemDto>[];
  attempts?: SyncEnvelope<PracticeAttemptDto>[];
  annotations?: SyncEnvelope<AnnotationDto>[];
}

export interface SyncEnvelope<T> {
  /** 本地记录（带客户端记录的 version/baseVersion） */
  entity: T;
  /** 客户端拉到该记录时所基于的版本；新建为 0 */
  baseVersion: number;
}

export interface SyncConflict<T> {
  id: string;
  entityType: keyof Omit<SyncPushPayload, 'deviceId'>;
  server: T;
  client: T;
  reason: 'version_conflict' | 'deleted';
}

export interface SyncPushResult {
  accepted: string[];
  conflicts: SyncConflict<any>[];
  rejected: { id: string; reason: string }[];
}

export interface SyncPullResult {
  /** 游标：取所有实体中最大的 updatedAt 时间戳 */
  cursor: string;
  users: UserDto[];
  speakers: SpeakerDto[];
  audio: AudioAssetDto[];
  courses: CourseDto[];
  courseItems: CourseItemDto[];
  attempts: PracticeAttemptDto[];
  annotations: AnnotationDto[];
}
