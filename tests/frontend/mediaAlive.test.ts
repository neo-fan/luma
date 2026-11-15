import { describe, expect, it } from "vitest";

import type { MediaLike } from "../../src/lib/mediaAlive";
import {
  mediaAdvanced,
  mediaIsAdvancing,
  mediaLooksAlive,
} from "../../src/lib/mediaAlive";

function media(overrides: Partial<MediaLike> = {}): MediaLike {
  return {
    readyState: 0,
    currentTime: 0,
    paused: true,
    ended: false,
    error: null,
    videoWidth: 0,
    ...overrides,
  };
}

describe("mediaLooksAlive：通用存活判据", () => {
  it("缓冲到当前帧就算活（用户暂停着也算知道线路通）", () => {
    expect(mediaLooksAlive(media({ readyState: 2 }))).toBe(true);
    expect(mediaLooksAlive(media({ readyState: 4 }))).toBe(true);
  });

  it("音频先出、视频轨还在解码时算活（readyState 只到 METADATA、videoWidth 为 0）", () => {
    const audioOnly = media({
      readyState: 1,
      currentTime: 12.4,
      paused: false,
      videoWidth: 0,
    });
    expect(mediaLooksAlive(audioOnly)).toBe(true);
  });

  it("只有拿到画面也算活（个别内核 readyState 更新滞后）", () => {
    expect(
      mediaLooksAlive(media({ readyState: 1, videoWidth: 1920 })),
    ).toBe(true);
  });

  it("没缓冲、没画面、没在走 = 不活", () => {
    expect(mediaLooksAlive(media())).toBe(false);
    expect(mediaLooksAlive(media({ readyState: 1, paused: false }))).toBe(
      false,
    );
    expect(mediaLooksAlive(null)).toBe(false);
  });

  it("有 error 一律不活：报错就是报错，不能因为时钟还在走就吞掉换线机会", () => {
    expect(
      mediaLooksAlive(
        media({ readyState: 4, currentTime: 9, paused: false, error: { code: 3 } }),
      ),
    ).toBe(false);
    expect(
      mediaLooksAlive(
        media({ currentTime: 9, paused: false, error: { code: 4 } }),
      ),
    ).toBe(false);
  });
});

describe("mediaIsAdvancing：媒体时钟在走", () => {
  it("在放且走过一段时间才算", () => {
    expect(mediaIsAdvancing(media({ currentTime: 0.4, paused: false }))).toBe(
      true,
    );
    expect(mediaIsAdvancing(media({ currentTime: 0, paused: false }))).toBe(
      false,
    );
  });

  it("暂停 / 结束 / 报错都不算", () => {
    expect(mediaIsAdvancing(media({ currentTime: 30, paused: true }))).toBe(
      false,
    );
    expect(
      mediaIsAdvancing(media({ currentTime: 30, paused: false, ended: true })),
    ).toBe(false);
    expect(
      mediaIsAdvancing(
        media({ currentTime: 30, paused: false, error: { code: 2 } }),
      ),
    ).toBe(false);
  });
});

describe("mediaAdvanced：判定窗口内前进", () => {
  it("窗口起点之后前进超过 0.3s 才算证据", () => {
    const playing = media({ currentTime: 10.8, paused: false });
    expect(mediaAdvanced(playing, 10.2)).toBe(true);
    expect(mediaAdvanced(playing, 10.7)).toBe(false);
  });

  it("暂停中的播放不算前进（不能拿用户暂停当线路证据）", () => {
    expect(mediaAdvanced(media({ currentTime: 40, paused: true }), 10)).toBe(
      false,
    );
  });

  it("报错 / null 一律不算", () => {
    expect(
      mediaAdvanced(
        media({ currentTime: 40, paused: false, error: { code: 3 } }),
        10,
      ),
    ).toBe(false);
    expect(mediaAdvanced(null, 0)).toBe(false);
  });
});
