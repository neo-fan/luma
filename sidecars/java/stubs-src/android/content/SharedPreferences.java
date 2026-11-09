package android.content;

import java.util.HashMap;
import java.util.Map;

/** 最小 SharedPreferences 桩：内存 Map，无持久化。 */
public class SharedPreferences {

    private final Map<String, Object> store = new HashMap<>();

    public String getString(String key, String defValue) {
        Object v = store.get(key);
        return v instanceof String ? (String) v : defValue;
    }

    public int getInt(String key, int defValue) {
        Object v = store.get(key);
        return v instanceof Integer ? (Integer) v : defValue;
    }

    public boolean getBoolean(String key, boolean defValue) {
        Object v = store.get(key);
        return v instanceof Boolean ? (Boolean) v : defValue;
    }

    public boolean contains(String key) {
        return store.containsKey(key);
    }

    public Editor edit() {
        return new Editor(store);
    }

    public static class Editor {
        private final Map<String, Object> store;

        Editor(Map<String, Object> store) {
            this.store = store;
        }

        public Editor putString(String key, String value) {
            store.put(key, value);
            return this;
        }

        public Editor putInt(String key, int value) {
            store.put(key, value);
            return this;
        }

        public Editor putBoolean(String key, boolean value) {
            store.put(key, value);
            return this;
        }

        public Editor remove(String key) {
            store.remove(key);
            return this;
        }

        public Editor clear() {
            store.clear();
            return this;
        }

        public boolean commit() {
            return true;
        }

        public void apply() {
        }
    }
}
