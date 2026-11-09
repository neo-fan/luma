package android.widget;

import android.content.Context;

/** 最小 Toast 桩：show 写 stderr，不弹 UI、不写 stdout。 */
public class Toast {

    public static final int LENGTH_SHORT = 0;
    public static final int LENGTH_LONG = 1;

    private CharSequence text;

    private Toast(CharSequence text) {
        this.text = text;
    }

    public static Toast makeText(Context context, CharSequence text, int duration) {
        return new Toast(text);
    }

    public void show() {
        System.err.println("[Toast] " + text);
    }

    public void setText(CharSequence text) {
        this.text = text;
    }
}
