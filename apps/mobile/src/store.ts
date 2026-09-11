import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  UserDto, SpeakerDto, AudioAssetDto, CourseDto, CourseItemDto,
  PracticeAttemptDto, AnnotationDto, Syncable, SyncConflict,
} from '@dialect/shared';

export type Bucket =
  | 'speakers'
  | 'audio'
  | 'courses'
  | 'courseItems'
  | 'attempts'
  | 'annotations';

/** 待推送的离线变更（含其拉取时的基线版本） */
export interface OutboxEntry<T extends Syncable = any> {
  bucket: Bucket;
  baseVersion: number;
  entity: T;
  /** 本地媒体文件 uri（元数据同步成功后再上传二进制） */
  localFileUri?: string;
  /** 上传后媒体挂载路径（/audio/:id/file） */
  uploadPath?: string;
  createdAt: string;
}

interface DataState {
  hydrated: boolean;
  me: UserDto | null;
  cursor: string | null;

  speakers: Record<string, SpeakerDto>;
  audio: Record<string, AudioAssetDto>;
  courses: Record<string, CourseDto>;
  courseItems: Record<string, CourseItemDto>;
  attempts: Record<string, PracticeAttemptDto>;
  annotations: Record<string, AnnotationDto>;
  /** id -> 本地录音文件 uri（加密后） */
  localMedia: Record<string, string>;

  outbox: OutboxEntry[];
  conflicts: SyncConflict<any>[];
  lastSyncAt: string | null;
  syncState: 'idle' | 'pulling' | 'pushing' | 'error';
  syncMessage: string | null;

  setMe: (me: UserDto | null) => void;
  setHydrated: () => void;

  /** 本地写：更新表 + 放入 outbox（baseVersion 取当前已知服务端版本） */
  upsertLocal: <T extends Syncable>(bucket: Bucket, entity: T, extra?: Partial<OutboxEntry>) => void;
  removeLocal: (bucket: Bucket, id: string) => void;
  attachLocalMedia: (id: string, uri: string) => void;

  /** 服务端拉取结果落库 */
  applyPull: (pull: import('@dialect/shared').SyncPullResult) => void;
  /** 合并单个服务端实体（冲突裁决后也可复用） */
  applyServerEntity: (bucket: Bucket, entity: Syncable) => void;

  shiftOutbox: (ids: string[]) => void;
  setConflicts: (c: SyncConflict<any>[]) => void;
  setSyncState: (s: DataState['syncState'], msg?: string | null) => void;
  setLastSyncAt: (t: string) => void;
  setOutbox: (o: OutboxEntry[]) => void;

  reset: () => void;
}

const emptyTables = () => ({
  speakers: {},
  audio: {},
  courses: {},
  courseItems: {},
  attempts: {},
  annotations: {},
  localMedia: {},
});

export const useStore = create<DataState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      me: null,
      cursor: null,
      ...emptyTables(),
      outbox: [],
      conflicts: [],
      lastSyncAt: null,
      syncState: 'idle',
      syncMessage: null,

      setMe: (me) => set({ me }),
      setHydrated: () => set({ hydrated: true }),

      upsertLocal: (bucket, entity, extra) => {        const state = get();
        const table = state[bucket] as Record<string, Syncable>;
        const previous = table[entity.id];
        const stamped: Syncable = {
          ...entity,
          updatedAt: new Date().toISOString(),
          version: previous ? Math.max(previous.version, entity.version || 1) : entity.version || 1,
        };
        const baseVersion = previous?.version ?? 0;

        const nextTable = { ...table, [entity.id]: stamped };
        const outbox = [
          ...state.outbox.filter((o) => !(o.bucket === bucket && o.entity.id === entity.id)),
          {
            bucket,
            baseVersion,
            entity: stamped,
            createdAt: new Date().toISOString(),
            ...extra,
          },
        ];
        set({ [bucket]: nextTable, outbox } as any);
      },

      removeLocal: (bucket, id) => {
        const state = get();
        const table = state[bucket] as Record<string, Syncable>;
        const previous = table[id];
        if (!previous) return;
        const tombstone: Syncable = { ...previous, deletedAt: new Date().toISOString() };
        set({
          [bucket]: { ...table, [id]: tombstone },
          outbox: [
            ...state.outbox.filter((o) => !(o.bucket === bucket && o.entity.id === id)),
            { bucket, baseVersion: previous.version, entity: tombstone, createdAt: new Date().toISOString() },
          ],
        } as any);
      },

      attachLocalMedia: (id, uri) =>
        set({ localMedia: { ...get().localMedia, [id]: uri } }),

      applyServerEntity: (bucket, entity) => {
        const table = get()[bucket] as Record<string, any>;
        set({ [bucket]: { ...table, [entity.id]: entity } } as any);
      },

      applyPull: (pull) => {
        const merge = <T extends Syncable>(local: Record<string, T>, remote: T[]) => {
          const next = { ...local };
          for (const e of remote) {
            const existing = next[e.id];
            // 未提交的本地编辑不能被静默覆盖，交由冲突流程处理
            const hasPending = get().outbox.some(
              (o) => (o.bucket as string) === bucketNameFor(next) && o.entity.id === e.id,
            );
            if (existing && hasPending) continue;
            next[e.id] = e;
          }
          return next;
        };

        set({
          speakers: merge(get().speakers, pull.speakers),
          audio: merge(get().audio, pull.audio),
          courses: merge(get().courses, pull.courses),
          courseItems: merge(get().courseItems, pull.courseItems),
          attempts: merge(get().attempts, pull.attempts),
          annotations: merge(get().annotations, pull.annotations),
          cursor: pull.cursor,
        } as any);
      },

      shiftOutbox: (ids) =>
        set({ outbox: get().outbox.filter((o) => !ids.includes(o.entity.id)) }),

      setConflicts: (conflicts) => set({ conflicts }),
      setSyncState: (syncState, syncMessage = null) => set({ syncState, syncMessage }),
      setLastSyncAt: (lastSyncAt) => set({ lastSyncAt }),
      setOutbox: (outbox) => set({ outbox }),

      reset: () =>
        set({
          me: null,
          cursor: null,
          ...emptyTables(),
          outbox: [],
          conflicts: [],
          lastSyncAt: null,
          syncState: 'idle',
        }),
    }),
    {
      name: 'dialect-store-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        me: s.me,
        cursor: s.cursor,
        speakers: s.speakers,
        audio: s.audio,
        courses: s.courses,
        courseItems: s.courseItems,
        attempts: s.attempts,
        annotations: s.annotations,
        localMedia: s.localMedia,
        outbox: s.outbox,
        lastSyncAt: s.lastSyncAt,
      }),
      onRehydrateStorage: () => (state) => state?.setHydrated(),
    },
  ),
);

/** merge() 里只用于跳过保护的桶名推断 */
function bucketNameFor(table: unknown): string {
  const state = useStore.getState();
  for (const name of ['speakers', 'audio', 'courses', 'courseItems', 'attempts', 'annotations'] as const) {
    if ((state as any)[name] === table) return name;
  }
  return '';
}
