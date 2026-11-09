package android.util;

/** 最小 Base64 桩：委托 JDK17 java.util.Base64，标志位仅做常量定义。 */
public final class Base64 {

    private Base64() {
    }

    public static final int DEFAULT = 0;
    public static final int NO_PADDING = 1;
    public static final int NO_WRAP = 2;
    public static final int URL_SAFE = 8;

    public static String encodeToString(byte[] input, int flags) {
        if (input == null) {
            return "";
        }
        java.util.Base64.Encoder enc = (flags & URL_SAFE) != 0
                ? java.util.Base64.getUrlEncoder() : java.util.Base64.getEncoder();
        if ((flags & NO_PADDING) != 0) {
            enc = enc.withoutPadding();
        }
        return enc.encodeToString(input);
    }

    public static byte[] decode(String str, int flags) {
        if (str == null) {
            return new byte[0];
        }
        java.util.Base64.Decoder dec = (flags & URL_SAFE) != 0
                ? java.util.Base64.getUrlDecoder() : java.util.Base64.getDecoder();
        return dec.decode(str);
    }
}
