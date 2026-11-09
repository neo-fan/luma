package com.tvbox.fixture;

import com.github.catvod.crawler.Spider;
import android.content.Context;
import java.util.HashMap;
import java.util.List;

/**
 * 自编合规空模板 spider（T-27）：不含任何第三方站点代码 / 网络请求。
 *
 * 仅返回本地静态 JSON，用于 P2 端到端断言。覆盖 6 个 Content 方法，
 * 每个方法返回可区分的内容（带 _method 字段、list 条数不同）。
 * init(Context, String) 收到的 ext 原样放进返回 JSON 的 extEcho 字段（8.5 透传断言）。
 *
 * 该源码同时用于编译 template-class.jar 与 template-dex.jar 内的等价 .class 资源，
 * 保证两种形态的 invoke 结果完全一致。
 */
public class TemplateSpider extends Spider {

    private String extEcho = "";

    @Override
    public void init(Context context, String extend) {
        this.extEcho = (extend == null) ? "" : extend;
    }

    /** 把静态 JSON 片段包成对象，并注入 extEcho / _method。inner 不含外层花括号。 */
    private String wrap(String method, String inner) {
        return "{" + inner
                + ",\"extEcho\":" + q(extEcho)
                + ",\"_method\":" + q(method)
                + "}";
    }

    /** 最小 JSON 字符串转义。 */
    private static String q(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append("\"").toString();
    }

    @Override
    public String homeContent(boolean filter) {
        // 首页：2 条 vod
        return wrap("homeContent",
                "\"list\":["
                + "{\"vod_id\":\"home-1\",\"vod_name\":\"Demo Home One\",\"vod_pic\":\"\",\"vod_remarks\":\"static\"},"
                + "{\"vod_id\":\"home-2\",\"vod_name\":\"Demo Home Two\",\"vod_pic\":\"\",\"vod_remarks\":\"static\"}],"
                + "\"page\":1,\"pagecount\":1,\"limit\":20,\"total\":2,"
                + "\"classes\":[{\"type_id\":\"1\",\"type_name\":\"Movie\"},{\"type_id\":\"2\",\"type_name\":\"Series\"}]");
    }

    @Override
    public String categoryContent(String tid, String pg, boolean filter, HashMap<String, String> extend) {
        return wrap("categoryContent",
                "\"list\":[{\"vod_id\":\"cat-1\",\"vod_name\":\"Demo Category Item\"}],"
                + "\"page\":1,\"pagecount\":1,\"limit\":20,\"total\":1,\"classes\":[]");
    }

    @Override
    public String detailContent(List<String> ids) {
        // vod_id 故意用数字，用于验证 Runner 归一化时「vod_id 强制字符串」。
        return "[{\"vod_id\":1001,\"vod_name\":\"Demo Detail\",\"type_name\":\"Movie\","
                + "\"vod_play_from\":\"static\","
                + "\"vod_play_url\":\"demo$$$http://127.0.0.1:8787/media/sample.mp4\","
                + "\"extEcho\":" + q(extEcho)
                + ",\"_method\":\"detailContent\"}]";
    }

    @Override
    public String searchContent(String key, boolean quick) {
        // 搜索：1 条 vod
        return wrap("searchContent",
                "\"list\":[{\"vod_id\":\"search-1\",\"vod_name\":\"Demo Search Result\"}],"
                + "\"page\":1,\"pagecount\":1,\"limit\":20,\"total\":1,\"classes\":[]");
    }

    @Override
    public String playerContent(String flag, String id, List<String> vipFlags) {
        // 播放地址只指向本机 127.0.0.1 桩服务，无任何外部地址。
        return wrap("playerContent",
                "\"playUrl\":\"http://127.0.0.1:8787/media/sample.mp4\","
                + "\"parse\":0,\"header\":\"\",\"playPage\":\"\"");
    }

    @Override
    public String liveContent(String url) {
        return wrap("liveContent",
                "\"live\":true,\"groups\":[{\"group\":\"Demo\",\"channels\":[]}]");
    }
}
