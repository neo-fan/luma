package android.util;

/** 最小 Log 桩：日志写 stderr，绝不写 stdout（stdout 只允许协议帧）。 */
public final class Log {

    private Log() {
    }

    public static int v(String tag, String msg) {
        return emit("V", tag, msg);
    }

    public static int d(String tag, String msg) {
        return emit("D", tag, msg);
    }

    public static int i(String tag, String msg) {
        return emit("I", tag, msg);
    }

    public static int w(String tag, String msg) {
        return emit("W", tag, msg);
    }

    public static int e(String tag, String msg) {
        return emit("E", tag, msg);
    }

    private static int emit(String level, String tag, String msg) {
        System.err.println("[Log/" + level + "] " + tag + ": " + msg);
        return 0;
    }
}
