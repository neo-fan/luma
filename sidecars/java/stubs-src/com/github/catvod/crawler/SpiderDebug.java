package com.github.catvod.crawler;

/** 自编调试桩：日志一律写 stderr，绝不写 stdout（stdout 只允许协议帧）。 */
public final class SpiderDebug {

    private SpiderDebug() {
    }

    public static void log(String msg) {
        if (msg != null) {
            System.err.println("[SpiderDebug] " + msg);
        }
    }

    public static void log(String tag, String msg) {
        log(tag + ": " + msg);
    }
}
