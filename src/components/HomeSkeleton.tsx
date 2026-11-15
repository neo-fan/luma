/**
 * 首页等待骨架（切配置 / 切站点 / 冷启动首次加载）。
 *
 * 为什么不是转圈：换源后首页要等新站点的推荐接口（CMS 站普遍 1~3s，
 * py / js 源可到 10s+）。居中 Spinner 出现在整页空白里，用户分不清是
 * 「还在旧源」还是「卡住了」。骨架直接复刻沉浸式首页的版式（整幅头图
 * + 为你推荐横排），数据到达时布局不跳变。
 *
 * 类名统一 `sk-home*`，**不复用** `.home-hero` / `.poster-rail` / `.vod-card`：
 * 探针靠这些选择器判断首页已就绪（如 `.home-hero__next`、`.poster-tile`），
 * 骨架混进去会被误判成真实内容。
 */
export default function HomeSkeleton() {
  return (
    <div className="sk-home" role="status" aria-label="正在加载首页内容">
      <div className="sk-home__hero">
        <div className="sk-home__poster" />
        <div className="sk-home__text">
          <div className="sk-line sk-line--title" />
          <div className="sk-home__chips">
            <span className="sk-pill" />
            <span className="sk-pill" />
            <span className="sk-pill" />
          </div>
          <div className="sk-line" />
          <div className="sk-line sk-line--short" />
        </div>
      </div>

      <div className="sk-home__rail">
        <div className="sk-line sk-line--subtitle" />
        <div className="sk-home__track">
          {Array.from({ length: 8 }, (_, index) => (
            <div className="sk-home__tile" key={index} />
          ))}
        </div>
      </div>
    </div>
  );
}
