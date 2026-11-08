/**
 * 前端唯一 IPC 入口（规格书 7.1 / 0 节第 5 条）。
 *
 * 所有系统能力必须经本模块走 Rust command；禁止在别处直接 import
 * `@tauri-apps/api`，禁止 import 任何 Node 内置模块。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AppError,
  ConfigMeta,
  ConfigSnapshot,
  ConfigSource,
  FetchRequest,
  FetchResponse,
  PlayRequest,
  PlayTarget,
  SpiderRequest,
} from "../types/tvbox";

/** 把 invoke 抛出的任意错误收敛成 AppError。 */
export function toAppError(err: unknown): AppError {
  if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
    return err as AppError;
  }
  if (typeof err === "string") {
    return { code: "INTERNAL", message: err };
  }
  return { code: "INTERNAL", message: "unknown IPC error", cause: String(err) };
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw toAppError(err);
  }
}

/** 7.1 的 7 个 command，一一对应，不额外暴露能力。 */
export const api = {
  configImport(source: ConfigSource): Promise<ConfigSnapshot> {
    return call("config_import", { source });
  },

  configList(): Promise<ConfigMeta[]> {
    return call("config_list");
  },

  configRemove(id: string): Promise<void> {
    return call("config_remove", { id });
  },

  spiderInvoke(req: SpiderRequest): Promise<unknown> {
    return call("spider_invoke", { req });
  },

  httpFetch(req: FetchRequest): Promise<FetchResponse> {
    return call("http_fetch", { req });
  },

  resolvePlay(req: PlayRequest): Promise<PlayTarget> {
    return call("resolve_play", { req });
  },

  openExternal(target: PlayTarget): Promise<void> {
    return call("open_external", { target });
  },
};

export type Api = typeof api;
