package com.github.catvod.crawler;

import android.content.Context;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * catvod Spider 抽象基类：自编最小桩，仅保留签名与最小行为，
 * 不复制任何 AGPL / 第三方源码。
 *
 * 12 个方法签名以规格书 7.4 基线为准（P2），供 TVBox jar 按精确字节码签名反射访问。
 * 默认实现统一返回「空结果」而非抛错，使未覆盖该方法的具体 spider 能安全降级：
 *   String -> ""，boolean -> false，proxy -> 空数组，void -> 无返回。
 */
public abstract class Spider {

    /** (Context, String) -> void；第二个参数即 ext，原样透传不可丢。 */
    public void init(Context context, String extend) {
    }

    public String homeContent(boolean filter) {
        return "";
    }

    public String homeVideoContent() {
        return "";
    }

    public String categoryContent(String tid, String pg, boolean filter, HashMap<String, String> extend) {
        return "";
    }

    public String detailContent(List<String> ids) {
        return "";
    }

    public String searchContent(String key, boolean quick) {
        return "";
    }

    public String playerContent(String flag, String id, List<String> vipFlags) {
        return "";
    }

    public String liveContent(String url) {
        return "";
    }

    /** (Map) -> Object[]，语义为 [contentType, headers, byte[]/stream]。 */
    public Object[] proxy(Map<String, String> params) {
        return new Object[0];
    }

    public boolean isVideoFormat(String url) {
        return false;
    }

    public boolean manualVideoCheck() {
        return false;
    }

    public void destroy() {
    }
}
