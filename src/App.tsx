import { RouterProvider } from "react-router-dom";
import { router } from "./routes";

/**
 * 应用入口：布局壳（侧栏/命令面板/配置同步）在 AppShell，路由表在 routes。
 * hash 路由——pathname 恒为 `/`，探针按 URL 选 target 的契约不受路由跳转影响。
 */
export default function App() {
  return <RouterProvider router={router} />;
}
