import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.zip.*;
import android.content.Context;

/**
 * P2 JVM sidecar：stdio 一行一帧 JSON-RPC 常驻桥（T-22 / T-23 / T-25）。
 *
 * 协议：
 *   stdin  一行一个 JSON 请求帧（UTF-8，\n 结尾）
 *   stdout 一行一个 JSON 响应帧（stdout 只允许协议帧）
 *   日志   全部写 stderr
 *
 * 启动：java -Dluma.proxy.port=9978 -cp runner.jar SpiderRunner
 *   runner.jar 自包含 stubs + Runner，单 -cp 即可启动。
 *
 * 设计要点：
 *  - 单线程顺序处理每帧，不开不可控线程；请求乱序时按 id 原样回带。
 *  - 任何 Throwable 都转结构化错误帧，单次调用绝不令 JVM 退出。
 *  - 单源墙钟超时由 Rust 侧进程级强杀（Job Object）负责，本 Runner 不派生超时线程。
 *  - 反射覆盖 8.4 登记的全部 12 个方法；未覆盖的方法由 Spider 桩基类给出空结果。
 *  - 结果统一归一化成 TVBox 形状（jar 通常返回 JSON 字符串）。
 */
public class SpiderRunner {

    private static final String VERSION = "p2";

    /** 自编 fixture 双形态兼容路径的常量（见 makeLoader / FixtureClassLoader 注释）。 */
    private static final String EQUIV_CLASS_RESOURCE = "META-INF/equivalent/TemplateSpider.bin";
    private static final String EQUIV_CLASS_NAME = "com.tvbox.fixture.TemplateSpider";
    private static final String FIXTURE_MARKER = "META-INF/tvbox-self-fixture.properties";
    private static final String DEX_UNSUPPORTED =
            "dex jar requires Android runtime / dex2jar (classes.dex); unsupported on Win x64";

    public static void main(String[] args) {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        Writer out = new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8));
        try {
            String line;
            while ((line = in.readLine()) != null) {
                if (line.trim().isEmpty()) {
                    continue;
                }
                String frame = handle(line);
                out.write(frame);
                out.write("\n");
                out.flush();
            }
        } catch (Throwable t) {
            log("main loop stopped: " + safeMsg(t));
        } finally {
            try {
                out.flush();
            } catch (IOException ignore) {
            }
        }
    }

    /** 单帧入口：永不向外抛异常，始终返回一个完整协议帧字符串。 */
    static String handle(String line) {
        Object id = null;
        try {
            Object parsed = Json.parse(line);
            if (!(parsed instanceof Map)) {
                return error(null, "BAD_REQUEST", "request is not a JSON object");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> req = (Map<String, Object>) parsed;
            id = req.get("id");
            String method = str(req.get("method"));
            Object pObj = req.get("params");
            @SuppressWarnings("unchecked")
            Map<String, Object> params = (pObj instanceof Map)
                    ? (Map<String, Object>) pObj : new LinkedHashMap<String, Object>();
            Object result;
            if ("ping".equals(method)) {
                result = ping();
            } else if ("probe".equals(method)) {
                result = probe(params);
            } else if ("invoke".equals(method)) {
                result = invoke(params);
            } else {
                return error(id, "UNKNOWN_METHOD", "unknown method: " + method);
            }
            return ok(id, result);
        } catch (FrameException fe) {
            return error(id, fe.code, fe.getMessage());
        } catch (Throwable t) {
            return error(id, "INTERNAL_ERROR", safeMsg(t));
        }
    }

    // ------------------------------------------------------------------ 帧构造

    static Object ping() {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("ok", Boolean.TRUE);
        r.put("version", VERSION);
        // 7.5.1 / T-25: the host injects the live proxy port via
        // -Dluma.proxy.port; echo it back so the acceptance script can prove
        // the injection actually reached the JVM (also read by SpiderApi).
        String port = System.getProperty("luma.proxy.port", "");
        if (port.isEmpty()) port = System.getProperty("tvbox.proxy.port", "");
        r.put("proxyPort", port);
        return r;
    }

    static String ok(Object id, Object result) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("ok", Boolean.TRUE);
        m.put("result", result);
        return Json.write(m);
    }

    static String error(Object id, String code, String message) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("code", code);
        e.put("message", message == null ? "" : message);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("ok", Boolean.FALSE);
        m.put("error", e);
        return Json.write(m);
    }

    /** 携带 code/message 的受控异常，用于生成指定 code 的结构化错误帧。 */
    static final class FrameException extends RuntimeException {
        final String code;

        FrameException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    // ------------------------------------------------------------------ probe

    /** probe 不得抛异常穿破帧协议：任何失败都归为 missing。 */
    static Object probe(Map<String, Object> p) {
        try {
            String jar = str(p.get("jar"));
            File f = resolveJarQuiet(jar);
            JarInfo info = inspect(f);
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("kind", info.kind);
            r.put("classes", (long) info.classes);
            return r;
        } catch (Throwable t) {
            log("probe failed: " + safeMsg(t));
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("kind", "missing");
            r.put("classes", (long) 0);
            return r;
        }
    }

    static final class JarInfo {
        String kind = "missing";
        int classes = 0;
        boolean dex = false;
        boolean selfFixture = false;
        byte[] equivBytes = null;
    }

    /** 用 java.util.zip.ZipFile 检查条目：含 .class -> class；只有 classes.dex 且无 .class -> dex；其它 -> missing。 */
    static JarInfo inspect(File f) {
        JarInfo info = new JarInfo();
        if (f == null || !f.isFile()) {
            return info;
        }
        try (ZipFile zf = new ZipFile(f)) {
            int classes = 0;
            boolean dex = false, selfFixture = false;
            byte[] equiv = null;
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) {
                    continue;
                }
                String n = e.getName();
                if (n.endsWith(".class")) {
                    classes++;
                }
                if (n.equals("classes.dex")) {
                    dex = true;
                }
                if (n.equals(FIXTURE_MARKER)) {
                    selfFixture = true;
                }
                if (n.equals(EQUIV_CLASS_RESOURCE)) {
                    try (InputStream in = zf.getInputStream(e)) {
                        equiv = in.readAllBytes();
                    }
                }
            }
            info.classes = classes;
            info.dex = dex;
            info.selfFixture = selfFixture;
            info.equivBytes = equiv;
            if (classes > 0) {
                info.kind = "class";
            } else if (dex) {
                info.kind = "dex";
            } else {
                info.kind = "missing";
            }
            return info;
        } catch (Throwable t) {
            log("inspect: " + safeMsg(t));
            return info; // kind 保持 missing
        }
    }

    // ------------------------------------------------------------------ jar 定位 / 下载

    static File resolveJarQuiet(String jar) {
        try {
            return resolveJar(jar);
        } catch (Throwable t) {
            log("resolveJar(probe): " + safeMsg(t));
            return null;
        }
    }

    static File resolveJar(String jar) throws Exception {
        if (jar == null || jar.isEmpty()) {
            return null;
        }
        if (jar.startsWith("http://") || jar.startsWith("https://")) {
            return download(jar);
        }
        File f = new File(jar);
        return f.isFile() ? f : null;
    }

    static File download(String urlStr) throws Exception {
        URL u = new URL(urlStr);
        java.net.Proxy px = proxyFromEnv(u.getProtocol());
        if (isLoopback(u.getHost())) {
            px = null; // 本地回环目标直连，不经过系统代理
        }
        HttpURLConnection c = px == null
                ? (HttpURLConnection) u.openConnection()
                : (HttpURLConnection) u.openConnection(px);
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "tvbox-p2/1.0");
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new IOException("HTTP " + code);
        }
        File tmp = File.createTempFile("tvbox-jar-", ".jar");
        tmp.deleteOnExit();
        try (InputStream in = c.getInputStream()) {
            Files.copy(in, tmp.toPath(), StandardCopyOption.REPLACE_EXISTING);
        } finally {
            c.disconnect();
        }
        return tmp;
    }

    static boolean isLoopback(String host) {
        if (host == null) return false;
        String h = host.toLowerCase();
        return h.equals("localhost") || h.equals("127.0.0.1") || h.equals("::1")
                || h.startsWith("127.");
    }

    /** JVM system property 之外，额外兼容环境中的 HTTP(S)_PROXY（curl 走系统代理的等价支持）。 */
    static java.net.Proxy proxyFromEnv(String scheme) {
        boolean https = "https".equalsIgnoreCase(scheme);
        String v = firstNonEmpty(System.getenv(https ? "HTTPS_PROXY" : "HTTP_PROXY"),
                System.getenv(https ? "https_proxy" : "http_proxy"));
        if (v == null) {
            return null;
        }
        try {
            URI uri = URI.create(v);
            String host = uri.getHost();
            int port = uri.getPort() > 0 ? uri.getPort() : 80;
            if (host == null) {
                return null;
            }
            return new java.net.Proxy(java.net.Proxy.Type.HTTP, new InetSocketAddress(host, port));
        } catch (Throwable t) {
            return null;
        }
    }

    static String firstNonEmpty(String a, String b) {
        if (a != null && !a.isEmpty()) return a;
        if (b != null && !b.isEmpty()) return b;
        return null;
    }

    // ------------------------------------------------------------------ invoke

    static Object invoke(Map<String, Object> p) throws Exception {
        String jar = str(p.get("jar"));
        String api = str(p.get("api"));
        String className = str(p.get("className"));
        String method = str(p.get("method"));
        Object aObj = p.get("args");
        @SuppressWarnings("unchecked")
        List<Object> args = (aObj instanceof List)
                ? (List<Object>) aObj : new ArrayList<Object>();
        Object extObj = p.get("ext");
        String ext = extObj == null ? "" : str(extObj);
        // timeoutMs 由 Rust 侧进程级强杀负责；读取仅作协议兼容，不据此派生线程。
        Object timeoutObj = p.get("timeoutMs");
        long timeoutMs = (timeoutObj instanceof Number) ? ((Number) timeoutObj).longValue() : 15000L;
        if (timeoutMs <= 0) {
            timeoutMs = 15000L;
        }

        String target = resolveClassName(api, className);
        File f;
        try {
            f = resolveJar(jar);
        } catch (Throwable t) {
            throw new FrameException("JAR_UNAVAILABLE", "jar download failed: " + safeMsg(t));
        }
        if (f == null || !f.isFile()) {
            throw new FrameException("JAR_UNAVAILABLE", "jar not found: " + jar);
        }
        JarInfo info = inspect(f);

        ClassLoader loader = null;
        try {
            loader = makeLoader(info, f, target);
            Class<?> cls = Class.forName(target, true, loader);
            Constructor<?> ctor = cls.getDeclaredConstructor();
            ctor.setAccessible(true);
            Object inst = ctor.newInstance();

            // 8.5：每次调用先按原样把 ext 透传给 init(Context, String)。
            callInit(inst, ext);

            Object raw = dispatch(inst, cls, method, args, ext);
            return normalize(method, raw);
        } finally {
            if (loader instanceof URLClassLoader) {
                try {
                    ((URLClassLoader) loader).close();
                } catch (Throwable ignore) {
                }
            }
        }
    }

    /** csp_X -> X；内置映射 Template -> 自编 fixture 类；否则 com.github.catvod.spider.<X>；className 优先。 */
    static String resolveClassName(String api, String className) {
        if (className != null && !className.isEmpty()) {
            return className;
        }
        String x = api == null ? "" : api;
        if (x.startsWith("csp_")) {
            x = x.substring(4);
        }
        if (x.isEmpty()) {
            x = "Template";
        }
        Map<String, String> builtin = new HashMap<>();
        builtin.put("Template", "com.tvbox.fixture.TemplateSpider");
        if (builtin.containsKey(x)) {
            return builtin.get(x);
        }
        return "com.github.catvod.spider." + x;
    }

    /**
     * 依形态选择 ClassLoader：
     *  - class：URLClassLoader(parent-first) 直接加载 jar。
     *  - dex + 自编 fixture 标记：走「自编双形态模板」兼容路径 —— dex jar 内附带等价
     *    .class 资源(.bin)，由 FixtureClassLoader 用 defineClass 兜底加载，返回与 class 版
     *    等价的 TVBox JSON。这是自编 fixture 专用兼容路径，第三方 dex 不在承诺范围。
     *  - dex + LUMA_DEX2JAR：调用外部 dex2jar 工具转换后加载（best-effort，未经本机实测）。
     *  - 其余 dex：返回 RUNTIME_UNAVAILABLE 结构化错误帧。
     */
    static ClassLoader makeLoader(JarInfo info, File f, String target) throws Exception {
        ClassLoader parent = SpiderRunner.class.getClassLoader();
        URL[] urls = new URL[]{f.toURI().toURL()};
        if ("class".equals(info.kind)) {
            return new URLClassLoader(urls, parent);
        }
        if ("dex".equals(info.kind)) {
            if (info.selfFixture && info.equivBytes != null && info.equivBytes.length > 0) {
                return new FixtureClassLoader(urls, parent, EQUIV_CLASS_NAME, info.equivBytes);
            }
            String tool = System.getenv("LUMA_DEX2JAR");
            if (tool == null || tool.isEmpty()) tool = System.getenv("TVBOX_DEX2JAR");
            if (tool != null && !tool.isEmpty()) {
                File converted = tryDex2jar(f, tool);
                if (converted != null) {
                    return new URLClassLoader(new URL[]{converted.toURI().toURL()}, parent);
                }
                log("dex2jar tool did not produce a usable class jar");
            }
            throw new FrameException("RUNTIME_UNAVAILABLE", DEX_UNSUPPORTED);
        }
        throw new FrameException("JAR_UNAVAILABLE", "jar is neither class nor dex: " + f.getPath());
    }

    /** 父优先：system CL 里不含 TemplateSpider，findClass 时用 jar 内等价 .class 字节 defineClass。 */
    static final class FixtureClassLoader extends URLClassLoader {
        private final String name;
        private final byte[] bytes;

        FixtureClassLoader(URL[] urls, ClassLoader parent, String name, byte[] bytes) {
            super(urls, parent);
            this.name = name;
            this.bytes = bytes;
        }

        @Override
        protected Class<?> findClass(String n) throws ClassNotFoundException {
            if (n.equals(name) && bytes != null) {
                return defineClass(n, bytes, 0, bytes.length);
            }
            return super.findClass(n);
        }
    }

    /**
     * best-effort dex2jar 转换（仅在显式设置 LUMA_DEX2JAR 时触发，本机自测未覆盖）。
     * 子进程输出重定向到 DISCARD，绝不污染 stdout 协议帧。
     */
    static File tryDex2jar(File dexJar, String tool) {
        try {
            File out = File.createTempFile("tvbox-dex2jar-", ".jar");
            out.deleteOnExit();
            List<String> cmd = new ArrayList<>();
            File tf = new File(tool);
            if (tool.endsWith(".jar") && tf.isFile()) {
                String javaBin = System.getProperty("java.home") + "/bin/java";
                if (new File(javaBin + ".exe").isFile()) {
                    javaBin += ".exe";
                }
                cmd.add(javaBin);
                cmd.add("-cp");
                cmd.add(tool);
                cmd.add("com.googlecode.dex2jar.tools.Dex2jarCmd");
            } else if (tf.isDirectory()) {
                String script = findD2jScript(tf);
                if (script == null) {
                    return null;
                }
                cmd.add(script);
            } else {
                cmd.add(tool);
            }
            cmd.add(dexJar.getAbsolutePath());
            cmd.add("-o");
            cmd.add(out.getAbsolutePath());
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            Process pr = pb.start();
            if (!pr.waitFor(60, TimeUnit.SECONDS)) {
                pr.destroyForcibly();
                return null;
            }
            if (pr.exitValue() != 0 || !out.isFile() || out.length() == 0) {
                return null;
            }
            return inspect(out).classes > 0 ? out : null;
        } catch (Throwable t) {
            log("dex2jar attempt failed: " + safeMsg(t));
            return null;
        }
    }

    static String findD2jScript(File dir) {
        String[] names = {"d2j-dex2jar.bat", "d2j-dex2jar.cmd", "d2j-dex2jar.sh",
                "dex2jar.bat", "dex2jar.sh"};
        for (String n : names) {
            File f = new File(dir, n);
            if (f.isFile()) {
                return f.getAbsolutePath();
            }
        }
        return null;
    }

    /** init(Context, String)：签名必须是 (android.content.Context, String)，ext 原样透传。 */
    static void callInit(Object inst, String ext) throws Exception {
        Method m = inst.getClass().getMethod("init", Context.class, String.class);
        m.setAccessible(true);
        m.invoke(inst, new Context(), ext);
    }

    // ------------------------------------------------------------------ 12 方法反射分发表

    enum PK { CONTEXT, STRING, BOOLEAN, HASHMAP, LIST, MAP }

    static final class ParamSpec {
        final PK kind;
        final Class<?> type;

        ParamSpec(PK kind, Class<?> type) {
            this.kind = kind;
            this.type = type;
        }
    }

    static ParamSpec P(PK k, Class<?> t) {
        return new ParamSpec(k, t);
    }

    static final Map<String, ParamSpec[]> PARAMS = new HashMap<>();

    static {
        PARAMS.put("init", new ParamSpec[]{P(PK.CONTEXT, Context.class), P(PK.STRING, String.class)});
        PARAMS.put("homeContent", new ParamSpec[]{P(PK.BOOLEAN, boolean.class)});
        PARAMS.put("homeVideoContent", new ParamSpec[]{});
        PARAMS.put("categoryContent", new ParamSpec[]{
                P(PK.STRING, String.class), P(PK.STRING, String.class),
                P(PK.BOOLEAN, boolean.class), P(PK.HASHMAP, HashMap.class)});
        PARAMS.put("detailContent", new ParamSpec[]{P(PK.LIST, List.class)});
        PARAMS.put("searchContent", new ParamSpec[]{P(PK.STRING, String.class), P(PK.BOOLEAN, boolean.class)});
        PARAMS.put("playerContent", new ParamSpec[]{
                P(PK.STRING, String.class), P(PK.STRING, String.class), P(PK.LIST, List.class)});
        PARAMS.put("liveContent", new ParamSpec[]{P(PK.STRING, String.class)});
        PARAMS.put("proxy", new ParamSpec[]{P(PK.MAP, Map.class)});
        PARAMS.put("isVideoFormat", new ParamSpec[]{P(PK.STRING, String.class)});
        PARAMS.put("manualVideoCheck", new ParamSpec[]{});
        PARAMS.put("destroy", new ParamSpec[]{});
    }

    /** 反射调用 12 个方法之一；参数从 JSON args 强制转换，缺参用默认值，绝不因签名不匹配而抛穿。 */
    static Object dispatch(Object inst, Class<?> cls, String method, List<Object> args, String ext) throws Exception {
        ParamSpec[] spec = PARAMS.get(method);
        if (spec == null) {
            // 未登记的未知方法名：返回空结果，不报错。
            return emptyFor(method);
        }
        Class<?>[] types = new Class<?>[spec.length];
        Object[] callArgs = new Object[spec.length];
        for (int i = 0; i < spec.length; i++) {
            types[i] = spec[i].type;
            Object src = i < args.size() ? args.get(i) : null;
            callArgs[i] = coerce(spec[i], src);
        }
        Method m;
        try {
            m = cls.getMethod(method, types);
        } catch (NoSuchMethodException e) {
            // 类未声明该方法：返回空结果，不报错。
            return emptyFor(method);
        }
        m.setAccessible(true);
        return m.invoke(inst, callArgs);
    }

    static Object coerce(ParamSpec ps, Object src) {
        switch (ps.kind) {
            case CONTEXT:
                return new Context();
            case STRING:
                return (src == null) ? "" : String.valueOf(src);
            case BOOLEAN:
                return toBool(src);
            case HASHMAP:
                return toHashMap(src);
            case LIST:
                return toList(src);
            case MAP:
                return toMap(src);
            default:
                return null;
        }
    }

    static boolean toBool(Object o) {
        if (o instanceof Boolean) return (Boolean) o;
        if (o instanceof Number) return ((Number) o).doubleValue() != 0;
        if (o instanceof String) return Boolean.parseBoolean((String) o);
        return false;
    }

    static HashMap<String, String> toHashMap(Object o) {
        HashMap<String, String> m = new HashMap<>();
        if (o instanceof Map) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
                m.put(String.valueOf(e.getKey()), e.getValue() == null ? null : String.valueOf(e.getValue()));
            }
        }
        return m;
    }

    static Map<String, String> toMap(Object o) {
        Map<String, String> m = new LinkedHashMap<>();
        if (o instanceof Map) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
                m.put(String.valueOf(e.getKey()), e.getValue() == null ? null : String.valueOf(e.getValue()));
            }
        }
        return m;
    }

    static List<Object> toList(Object o) {
        if (o instanceof List) return new ArrayList<>((List<?>) o);
        if (o instanceof Object[]) return new ArrayList<>(Arrays.asList((Object[]) o));
        return new ArrayList<>();
    }

    /** 未实现方法的「空结果」：String->""、boolean->false、proxy->空数组、void->null。 */
    static Object emptyFor(String method) {
        if ("isVideoFormat".equals(method) || "manualVideoCheck".equals(method)) return Boolean.FALSE;
        if ("proxy".equals(method)) return new Object[0];
        if ("init".equals(method) || "destroy".equals(method)) return null;
        return "";
    }

    // ------------------------------------------------------------------ 结果归一化（TVBox 形状）

    static Object normalize(String method, Object raw) {
        if ("isVideoFormat".equals(method) || "manualVideoCheck".equals(method)) {
            return (raw instanceof Boolean) ? raw : Boolean.FALSE;
        }
        if ("init".equals(method) || "destroy".equals(method)) {
            return null;
        }
        if ("proxy".equals(method)) {
            if (raw instanceof Object[]) return new ArrayList<>(Arrays.asList((Object[]) raw));
            if (raw instanceof Collection) return new ArrayList<>((Collection<?>) raw);
            return new ArrayList<>();
        }
        if ("detailContent".equals(method)) {
            return normalizeDetail(raw);
        }
        if ("playerContent".equals(method) || "liveContent".equals(method)) {
            return parseToMap(raw);
        }
        if (isPageMethod(method)) {
            return normalizePage(raw);
        }
        // 未登记方法：空字典，不抛穿。
        return parseToMap(raw);
    }

    static boolean isPageMethod(String method) {
        return "homeContent".equals(method) || "homeVideoContent".equals(method)
                || "categoryContent".equals(method) || "searchContent".equals(method);
    }

    /** 解析成 dict 并确保 list/page/pagecount/limit/total/classes；解析失败返回空结构。 */
    static Map<String, Object> normalizePage(Object raw) {
        Object parsed = tryParse(raw);
        Map<String, Object> m = new LinkedHashMap<>();
        if (parsed instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> src = (Map<String, Object>) parsed;
            m.putAll(src);
        }
        if (!m.containsKey("list")) m.put("list", new ArrayList<>());
        if (!m.containsKey("page")) m.put("page", 1L);
        if (!m.containsKey("pagecount")) m.put("pagecount", 1L);
        if (!m.containsKey("limit")) m.put("limit", 20L);
        if (!m.containsKey("total")) m.put("total", 0L);
        if (!m.containsKey("classes")) m.put("classes", new ArrayList<>());
        return m;
    }

    /** detailContent -> 数组，每项 vod_id 强制字符串；解析失败返回空数组。 */
    static List<Object> normalizeDetail(Object raw) {
        Object parsed = tryParse(raw);
        List<Object> out = new ArrayList<>();
        if (parsed instanceof List) {
            for (Object item : (List<?>) parsed) {
                if (item instanceof Map) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> copy = new LinkedHashMap<>((Map<String, Object>) item);
                    if (copy.containsKey("vod_id")) {
                        copy.put("vod_id", String.valueOf(copy.get("vod_id")));
                    }
                    out.add(copy);
                } else {
                    out.add(item);
                }
            }
        }
        return out;
    }

    /** playerContent / liveContent -> dict 原样，解析失败返回空 dict。 */
    static Map<String, Object> parseToMap(Object raw) {
        Object parsed = tryParse(raw);
        if (parsed instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> src = (Map<String, Object>) parsed;
            return new LinkedHashMap<>(src);
        }
        return new LinkedHashMap<>();
    }

    static Object tryParse(Object raw) {
        if (raw == null) return null;
        if (raw instanceof String) {
            String s = ((String) raw).trim();
            if (s.isEmpty()) return null;
            try {
                return Json.parse(s);
            } catch (Throwable t) {
                return null;
            }
        }
        if (raw instanceof Map || raw instanceof List) return raw;
        return null;
    }

    // ------------------------------------------------------------------ 小工具

    static String str(Object o) {
        return (o instanceof String) ? (String) o : (o == null ? "" : String.valueOf(o));
    }

    static void log(String s) {
        System.err.println("[SpiderRunner] " + s);
    }

    static String safeMsg(Throwable t) {
        Throwable c = t;
        if (c instanceof InvocationTargetException && c.getCause() != null) {
            c = c.getCause();
        }
        String m = c.getMessage();
        return c.getClass().getSimpleName() + (m == null ? "" : ": " + m);
    }

    // ------------------------------------------------------------------ 极简 JSON（解析 + 序列化，无第三方依赖）

    static final class Json {

        static Object parse(String s) {
            P p = new P(s);
            Object v = p.value();
            p.ws();
            if (p.i < p.n) throw new RuntimeException("trailing JSON at " + p.i);
            return v;
        }

        static final class P {
            final String s;
            final int n;
            int i = 0;

            P(String s) {
                this.s = s;
                this.n = s.length();
            }

            void ws() {
                while (i < n) {
                    char c = s.charAt(i);
                    if (c == ' ' || c == '\t' || c == '\r' || c == '\n') i++;
                    else break;
                }
            }

            char peek() {
                return i < n ? s.charAt(i) : '\0';
            }

            Object value() {
                ws();
                if (i >= n) throw new RuntimeException("unexpected end");
                char c = s.charAt(i);
                if (c == '{') return object();
                if (c == '[') return array();
                if (c == '"') return string();
                if (c == 't') { lit("true"); return Boolean.TRUE; }
                if (c == 'f') { lit("false"); return Boolean.FALSE; }
                if (c == 'n') { lit("null"); return null; }
                if (c == '-' || (c >= '0' && c <= '9')) return number();
                throw new RuntimeException("bad JSON char '" + c + "' at " + i);
            }

            void lit(String w) {
                if (!s.startsWith(w, i)) throw new RuntimeException("bad literal at " + i);
                i += w.length();
            }

            Map<String, Object> object() {
                Map<String, Object> m = new LinkedHashMap<>();
                i++;
                ws();
                if (peek() == '}') { i++; return m; }
                while (true) {
                    ws();
                    if (peek() != '"') throw new RuntimeException("expected key at " + i);
                    String k = string();
                    ws();
                    if (peek() != ':') throw new RuntimeException("expected ':' at " + i);
                    i++;
                    m.put(k, value());
                    ws();
                    char c = peek();
                    if (c == ',') { i++; continue; }
                    if (c == '}') { i++; break; }
                    throw new RuntimeException("expected ',' or '}' at " + i);
                }
                return m;
            }

            List<Object> array() {
                List<Object> a = new ArrayList<>();
                i++;
                ws();
                if (peek() == ']') { i++; return a; }
                while (true) {
                    a.add(value());
                    ws();
                    char c = peek();
                    if (c == ',') { i++; continue; }
                    if (c == ']') { i++; break; }
                    throw new RuntimeException("expected ',' or ']' at " + i);
                }
                return a;
            }

            String string() {
                StringBuilder sb = new StringBuilder();
                i++; // 起始引号
                while (i < n) {
                    char c = s.charAt(i++);
                    if (c == '"') return sb.toString();
                    if (c == '\\') {
                        if (i >= n) break;
                        char e = s.charAt(i++);
                        switch (e) {
                            case '"': sb.append('"'); break;
                            case '\\': sb.append('\\'); break;
                            case '/': sb.append('/'); break;
                            case 'b': sb.append('\b'); break;
                            case 'f': sb.append('\f'); break;
                            case 'n': sb.append('\n'); break;
                            case 'r': sb.append('\r'); break;
                            case 't': sb.append('\t'); break;
                            case 'u':
                                if (i + 4 > n) throw new RuntimeException("bad unicode escape");
                                sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                                i += 4;
                                break;
                            default: throw new RuntimeException("bad escape \\" + e);
                        }
                    } else {
                        sb.append(c);
                    }
                }
                throw new RuntimeException("unterminated string");
            }

            Object number() {
                int start = i;
                if (peek() == '-') i++;
                while (i < n && Character.isDigit(s.charAt(i))) i++;
                boolean fp = false;
                if (i < n && s.charAt(i) == '.') {
                    fp = true;
                    i++;
                    while (i < n && Character.isDigit(s.charAt(i))) i++;
                }
                if (i < n && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                    fp = true;
                    i++;
                    if (i < n && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
                    while (i < n && Character.isDigit(s.charAt(i))) i++;
                }
                String t = s.substring(start, i);
                if (fp) return Double.parseDouble(t);
                try {
                    return Long.parseLong(t);
                } catch (NumberFormatException e) {
                    return Double.parseDouble(t);
                }
            }
        }

        static String write(Object o) {
            StringBuilder sb = new StringBuilder();
            writeVal(o, sb);
            return sb.toString();
        }

        static void writeVal(Object o, StringBuilder sb) {
            if (o == null) {
                sb.append("null");
                return;
            }
            if (o instanceof String) {
                writeStr((String) o, sb);
                return;
            }
            if (o instanceof Boolean) {
                sb.append(((Boolean) o) ? "true" : "false");
                return;
            }
            if (o instanceof Number) {
                if (o instanceof Double || o instanceof Float) {
                    double d = ((Number) o).doubleValue();
                    if (Double.isNaN(d) || Double.isInfinite(d)) {
                        sb.append("null");
                        return;
                    }
                }
                sb.append(o.toString());
                return;
            }
            if (o instanceof Map) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    writeStr(String.valueOf(e.getKey()), sb);
                    sb.append(':');
                    writeVal(e.getValue(), sb);
                }
                sb.append('}');
                return;
            }
            if (o instanceof Iterable) {
                sb.append('[');
                boolean first = true;
                for (Object x : (Iterable<?>) o) {
                    if (!first) sb.append(',');
                    first = false;
                    writeVal(x, sb);
                }
                sb.append(']');
                return;
            }
            if (o instanceof Object[]) {
                sb.append('[');
                Object[] arr = (Object[]) o;
                for (int i = 0; i < arr.length; i++) {
                    if (i > 0) sb.append(',');
                    writeVal(arr[i], sb);
                }
                sb.append(']');
                return;
            }
            writeStr(String.valueOf(o), sb);
        }

        static void writeStr(String s, StringBuilder sb) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    case '\b': sb.append("\\b"); break;
                    case '\f': sb.append("\\f"); break;
                    default:
                        if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                }
            }
            sb.append('"');
        }
    }
}
