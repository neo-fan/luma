/**
 * 详情页等待骨架。
 *
 * 为什么不是转圈：从收藏 / 历史点进来时，详情要跨源检索（可能还有按名回查），
 * 一两秒到十几秒都有可能。一个居中小转圈放在整页空白里，既不知道在等什么，
 * 也不知道等多久，出来的东西还和这个空白毫无关系——观感就是「卡住」。
 *
 * 骨架直接复刻加载完成后的版式（左海报 + 右侧标题/信息/操作 + 下方剧集格），
 * 数据到达时元素位置不跳变，等待过程本身就在回答「马上会出现什么」。
 *
 * 类名统一 `sk-detail*`，**不复用** `.detail-hero` / `.episode`：探针靠这些
 * 选择器判断详情已就绪，骨架混进去会被误判成真实数据。
 */
export default function DetailSkeleton() {
  return (
    <div className="sk-detail" role="status" aria-label="正在加载详情">
      <div className="sk-detail__hero">
        <div className="sk-detail__poster" />
        <div className="sk-detail__info">
          <div className="sk-line sk-line--title" />
          <div className="sk-detail__chips">
            <span className="sk-pill" />
            <span className="sk-pill" />
            <span className="sk-pill" />
          </div>
          <div className="sk-line" />
          <div className="sk-line" />
          <div className="sk-line sk-line--short" />
          <div className="sk-detail__actions">
            <span className="sk-pill sk-pill--button" />
            <span className="sk-pill sk-pill--button" />
          </div>
        </div>
      </div>

      <div className="sk-detail__section">
        <div className="sk-line sk-line--subtitle" />
        <div className="sk-detail__lines">
          <span className="sk-pill" />
          <span className="sk-pill" />
          <span className="sk-pill" />
        </div>
        <div className="sk-detail__episodes">
          {Array.from({ length: 16 }, (_, index) => (
            <span className="sk-episode" key={index} />
          ))}
        </div>
      </div>
    </div>
  );
}
