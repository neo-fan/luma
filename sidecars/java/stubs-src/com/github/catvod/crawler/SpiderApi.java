package com.github.catvod.crawler;

/**
 * 宿主能力静态入口：把 -Dtvbox.proxy.port 暴露给 jar。
 *
 * Runner 由 Rust 以 java -Dtvbox.proxy.port=&lt;port&gt; ... SpiderRunner 启动，
 * 该 system property 已存在于同一 JVM；jar 可直接 System.getProperty("tvbox.proxy.port")
 * 读取，也可通过本 helper 读取（模板 jar 不需要真正实现网络代理）。
 */
public final class SpiderApi {

    private SpiderApi() {
    }

    public static int getProxyPort() {
        String v = System.getProperty("tvbox.proxy.port");
        if (v == null || v.isEmpty()) {
            return 9978;
        }
        try {
            return Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return 9978;
        }
    }

    public static String getProxyHost() {
        return "127.0.0.1";
    }

    public static String getProxyBaseUrl() {
        return "http://" + getProxyHost() + ":" + getProxyPort();
    }
}
