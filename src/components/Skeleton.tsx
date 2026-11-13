interface SearchSkeletonProps {
  /** 骨架卡片数；默认 12 张约填满一屏。 */
  count?: number;
}

/**
 * 聚合搜索等待期的卡片网格骨架。
 *
 * 为什么不用 Spinner：聚合要等 10~20 秒，孤立转圈让人「不知道在干嘛」；
 * 骨架网格预示「结果会以这种卡片出现」，且与结果网格同布局，
 * 数据到达时视觉位置不跳变。
 *
 * 故意不用 `.vod-card` 类名：探针靠 `.vod-card` 数量判断结果就绪，
 * 骨架混进去会被当成结果。
 */
export default function SearchSkeleton({ count = 12 }: SearchSkeletonProps) {
  return (
    <div className="sk-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="sk-card" key={i}>
          <div className="sk-card__poster" />
          <div className="sk-card__line" />
          <div className="sk-card__line sk-card__line--short" />
        </div>
      ))}
    </div>
  );
}
