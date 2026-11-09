package android.os;

/** 最小 Handler 桩：post 在当前线程同步执行，不创建不可控线程。 */
public class Handler {

    public Handler() {
    }

    public boolean post(Runnable r) {
        if (r != null) {
            r.run();
        }
        return true;
    }

    public boolean postDelayed(Runnable r, long delayMillis) {
        return post(r);
    }

    public void removeCallbacks(Runnable r) {
    }
}
