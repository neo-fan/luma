package android.content;

import java.io.File;

/** 最小 Android Context 桩（仅签名与最小行为，不复制任何第三方源码）。 */
public class Context {

    public Context() {
    }

    public SharedPreferences getSharedPreferences(String name, int mode) {
        return new SharedPreferences();
    }

    public String getPackageName() {
        return "com.tvbox.stub";
    }

    public File getFilesDir() {
        return new File(System.getProperty("java.io.tmpdir"), "tvbox-files");
    }

    public File getCacheDir() {
        return new File(System.getProperty("java.io.tmpdir"), "tvbox-cache");
    }

    public File getExternalFilesDir(String type) {
        return getFilesDir();
    }

    public Object getSystemService(String name) {
        return null;
    }

    public Context getApplicationContext() {
        return this;
    }
}
