import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  UserDto, SpeakerDto, AudioAssetDto, CourseDto, CourseItemDto,
  PracticeAttemptDto, AnnotationDto, Syncable, SyncConflict, SyncPullResult,
} from '@dialect/shared';
import { sanitizeClientIso } from '@dialect/shared';

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
  applyPull: (pull: SyncPullResult) => void;
  /** 合并单个服务端实体（冲突裁决后也可复用） */
  applyServerEntity: (bucket: Bucket, entity: Syncable) => void;
  /** 冲突裁决为「采用服务端」且服务端记录已删除时：丢弃本地记录与待推送队列项 */
  discardLocalRecord: (bucket: Bucket, id: string) => void;
  /** 裁决后按 (bucket,id) 精确移除冲突 */
  clearConflict: (bucket: string, id: string) => void;

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

      upsertLocal: (bucket, entity, extra) => {
        const state = get();
        const table = state[bucket] as Record<string, Syncable>;
        const previous = table[entity.id];
        // 本地盖戳同样做未来时间钳制：设备时钟被调到未来时，
        // 自己产生的记录也不能毒化服务端游标或在 LWW 中永远压过别人。
        const stamp = sanitizeClientIso(new Date().toISOString());
        const stamped: Syncable = {
          ...entity,
          updatedAt: stamp,
          version: previous ? Math.max(previous.version, entity.version || 1) : entity.version || 1,
        };
        // baseVersion 必须是「上次与服务器同步时」的版本：
        //  - 已在 outbox 中（连续离线编辑）→ 沿用原 baseVersion，绝不能抬成本地自增版本，
        //    否则本地新建记录第二次编辑后会被服务端误判为 deleted 冲突；
        //  - 否则取当前已知版本（本地表是上次 pull 的快照）。
        const pending = state.outbox.find(
          (o) => o.bucket === bucket && o.entity.id === entity.id,
        );
        const baseVersion = pending ? pending.baseVersion : previous?.version ?? 0;

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
        const pending = state.outbox.find((o) => o.bucket === bucket && o.entity.id === id);
        const others = state.outbox.filter((o) => !(o.bucket === bucket && o.entity.id === id));
        const nextTable = { ...table };

        // 从未成功推送到服务端（baseVersion=0）的本地记录：直接本地丢弃，不下发墓碑
        const baseVersion = pending ? pending.baseVersion : previous.version;
        if (baseVersion === 0) {
          delete nextTable[id];
          set({ [bucket]: nextTable, outbox: others } as any);
          return;
        }

        const tombstone: Syncable = { ...previous, deletedAt: new Date().toISOString() };
        nextTable[id] = tombstone;
        set({
          [bucket]: nextTable,
          outbox: [
            ...others,
            { bucket, baseVersion, entity: tombstone, createdAt: new Date().toISOString() },
          ],
        } as any);
      },

      attachLocalMedia: (id, uri) =>
        set({ localMedia: { ...get().localMedia, [id]: uri } }),

      applyServerEntity: (bucket, entity) => {
        const table = get()[bucket] as Record<string, any>;
        set({ [bucket]: { ...table, [entity.id]: entity } } as any);
      },

      discardLocalRecord: (bucket, id) => {
        const table = get()[bucket] as Record<string, any>;
        const next = { ...table };
        delete next[id];
        set({
          [bucket]: next,
          outbox: get().outbox.filter((o) => !(o.bucket === bucket && o.entity.id === id)),
        } as any);
      },

      clearConflict: (bucket, id) =>
        set({ conflicts: get().conflicts.filter((c) => !(c.entityType === bucket && c.id === id)) }),

      applyPull: (pull) => {
        // 关键：outbox 中仍待推送的记录（无论新建/编辑/软删）一律不得被
        // 拉取结果静默覆盖——否则离线编辑会在联网同步时丢失、版本合并形同虚设。
        // 这些记录由 push 的冲突结果（或用户在冲突卡片上的裁决）决定最终版本。
        const s = get();
        const pendingByBucket: Record<string, Set<string>> = {};
        for (const o of s.outbox) {
          (pendingByBucket[o.bucket] ??= new Set<string>()).add(o.entity.id);
        }

        const mergeTable = <T extends Syncable>(bucket: Bucket, local: Record<string, T>, remote: T[]) => {
          const protectedIds = pendingByBucket[bucket];
          if (!protectedIds || protectedIds.size === 0) {
            // 无待推送编辑：服务端快照直接为准（含墓碑）
            const next = { ...local };
            for (const e of remote) next[e.id] = e;
            return next;
          }
          const next = { ...local };
          for (const e of remote) {
            if (protectedIds.has(e.id)) continue; // 保留本地版本，等待 push 合并
            next[e.id] = e;
          }
          return next;
        };

        set({
          speakers: mergeTable('speakers', s.speakers, pull.speakers),
          audio: mergeTable('audio', s.audio, pull.audio),
          courses: mergeTable('courses', s.courses, pull.courses),
          courseItems: mergeTable('courseItems', s.courseItems, pull.courseItems),
          attempts: mergeTable('attempts', s.attempts, pull.attempts),
          annotations: mergeTable('annotations', s.annotations, pull.annotations),
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
        conflicts: s.conflicts,
        lastSyncAt: s.lastSyncAt,
      }),
      onRehydrateStorage: () => (state) => state?.setHydrated(),
    },
  ),
);
