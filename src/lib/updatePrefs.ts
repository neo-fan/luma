/**
 * 自动升级的本机偏好。
 *
 * 只放四件事：是否自动检查、上次真正发起检查的时间、用户点掉过提示的版本，
 * 以及一次安装的目标版本（下次启动据此回执结果）。都是展示策略，不进配置快照、
 * 也不进后端——换订阅或重装应用都不该改变「多久提醒一次」。手动检查永远可用。
 */
const KEY = "luma.update.prefs";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UpdatePrefs {
  /** 启动后静默检查新版本。 */
  autoCheck: boolean;
  /** 上次发起检查的时间戳（ms）；0 = 从未检查。 */
  lastCheckAt: number;
  /** 已被用户点掉的版本号：同一版本不再自动提醒。 */
  dismissedVersion: string;
  /** 已发起安装、等待下次启动核对结果的目标版本；空串 = 没有在途更新。 */
  pendingVersion: string;
}

const DEFAULTS: UpdatePrefs = {
  autoCheck: true,
  lastCheckAt: 0,
  dismissedVersion: "",
  pendingVersion: "",
};

export function readUpdatePrefs(): UpdatePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return DEFAULTS;
    }
    const parsed = JSON.parse(raw) as Partial<UpdatePrefs>;
    return {
      autoCheck: parsed.autoCheck !== false,
      lastCheckAt: Number(parsed.lastCheckAt) || 0,
      dismissedVersion:
        typeof parsed.dismissedVersion === "string" ? parsed.dismissedVersion : "",
      pendingVersion:
        typeof parsed.pendingVersion === "string" ? parsed.pendingVersion : "",
    };
  } catch {
    // 存储被禁用或内容损坏：按默认值走，不要让更新检查拖垮整个壳。
    return DEFAULTS;
  }
}

export function writeUpdatePrefs(patch: Partial<UpdatePrefs>): UpdatePrefs {
  const next = { ...readUpdatePrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 隐私模式写不进去：本次会话内仍然生效，不必报错。
  }
  return next;
}

/** 开关打开且距上次检查超过一天才自动检查：每次启动都打一次代理没有必要。 */
export function shouldAutoCheck(prefs: UpdatePrefs = readUpdatePrefs()): boolean {
  return prefs.autoCheck && Date.now() - prefs.lastCheckAt >= DAY_MS;
}
