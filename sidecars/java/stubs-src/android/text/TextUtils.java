package android.text;

/** 最小 TextUtils 桩。 */
public final class TextUtils {

    private TextUtils() {
    }

    public static boolean isEmpty(CharSequence s) {
        return s == null || s.length() == 0;
    }

    public static String join(CharSequence delimiter, Iterable<?> tokens) {
        StringBuilder sb = new StringBuilder();
        boolean first = true;
        for (Object t : tokens) {
            if (!first) {
                sb.append(delimiter);
            }
            sb.append(t);
            first = false;
        }
        return sb.toString();
    }

    public static boolean equals(CharSequence a, CharSequence b) {
        return a == null ? b == null : a.equals(b);
    }
}
