package android.os;

import java.io.File;

/** 最小 Environment 桩。 */
public final class Environment {

    private Environment() {
    }

    public static final String MEDIA_MOUNTED = "mounted";

    public static File getExternalStorageDirectory() {
        return new File(System.getProperty("java.io.tmpdir"), "tvbox-sdcard");
    }

    public static String getExternalStorageState() {
        return MEDIA_MOUNTED;
    }

    public static File getDownloadCacheDirectory() {
        return new File(System.getProperty("java.io.tmpdir"), "tvbox-download");
    }
}
