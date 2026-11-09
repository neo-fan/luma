package android.net;

/** 最小 android.net.Uri 桩。 */
public class Uri {

    private final String raw;

    private Uri(String raw) {
        this.raw = raw;
    }

    public static Uri parse(String raw) {
        return new Uri(raw == null ? "" : raw);
    }

    @Override
    public String toString() {
        return raw;
    }

    public String getScheme() {
        int i = raw.indexOf(':');
        return i < 0 ? null : raw.substring(0, i);
    }

    public String getHost() {
        return null;
    }

    public String getPath() {
        return raw;
    }

    public String getQueryParameter(String key) {
        return null;
    }

    public boolean isAbsolute() {
        return raw.contains(":");
    }
}
