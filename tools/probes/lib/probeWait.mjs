/**
 * 探针共用的「跨 reload 等待」助手。
 *
 * 背景（2026-11-20 套件实测，source_picker / artplayer / page_cache 同病）：
 * 探针在 `Page.reload` 之后立刻用页内 WAIT（单条 eval 里自旋）等 DOM 就绪。
 * 那条 eval 可能整条落进**旧执行上下文**——旧 DOM 同样满足 `.nav__item` 这类
 * 存在性断言，WAIT 立刻返回假绿；紧接着的下一条 eval 却落在新上下文的未挂载
 * DOM 上，于是「boot ok → 后面整串假红」。reload 之后的第一个等待必须换成
 * 宿主侧轮询：每次尝试重新发一条 Runtime.evaluate，eval 异常（上下文被销毁）
 * 按「未就绪」处理。
 */

/**
 * 宿主侧等待：每 intervalMs 重发一条 eval，直到 expression 返回真值或超时。
 * expression 可以是纯表达式（IIFE/三元），也可以是 `return …` 语句——后者
 * 会自动包一层箭头函数（Runtime.evaluate 不接受顶层 return，直接发会每次
 * SyntaxError、被下面 catch 吞成永远 null，2026-11-20 source_picker 实测）。
 */
function asExpression(expression) {
  const trimmed = expression.trim();
  if (trimmed.startsWith("return ") || trimmed.startsWith("return;")) {
    return `(() => { ${trimmed} })()`;
  }
  return trimmed;
}

export async function waitEval(cdp, expression, timeoutMs = 45000, intervalMs = 400) {
  const evalExpression = asExpression(expression);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await cdp.eval(evalExpression);
      if (value !== null && value !== undefined && value !== false && value !== "") {
        return value;
      }
    } catch {
      /* reload 销毁上下文：按未就绪处理，下一拍重试 */
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/**
 * reload 并等新上下文挂载完成，返回 mountExpression 的首个真值。
 *
 * 两段式：reload 前先在 window 上立一个 mark（window 属性，不落 storage，
 * 新上下文里必然消失）。阶段一只等「mark 读不到」——要么 eval 抛错（上下文
 * 正在销毁），要么已经切到新上下文（typeof 不再是 boolean）；阶段二才在新
 * 上下文里等 mount predicate。没有阶段一，任何「存在性」断言都可能被旧
 * 上下文立刻满足（假绿根源）。
 */
export async function reloadAndWait(cdp, mountExpression, timeoutMs = 60000) {
  const mark = `__lumaProbeMark_${Date.now()}`;
  try {
    await cdp.eval(`window.${mark} = true; 'MARKED'`);
  } catch {
    /* 旧上下文可能已死，reload 照发 */
  }
  await cdp.send("Page.reload", { ignoreCache: true });
  const freshDeadline = Date.now() + timeoutMs;
  while (Date.now() < freshDeadline) {
    try {
      const marked = await cdp.eval(`typeof window.${mark}`);
      if (marked !== "boolean") break;
    } catch {
      break; // 上下文销毁 = reload 在途，新上下文马上到
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return waitEval(cdp, mountExpression, timeoutMs, 400);
}

/**
 * 应用外壳挂载的判据：侧栏出现带文本的 首页 / 搜索 项。返回 nav 文本数组
 * 的 JSON（宿主侧可再断言具体项），文本齐备说明 React 树已挂、不是中间态。
 */
export const NAV_READY = `(() => {
  const items = [...document.querySelectorAll('.nav__item')].map((n) => (n.textContent || '').trim());
  const ok = items.some((t) => t.includes('首页')) && items.some((t) => t.includes('搜索'));
  return ok ? JSON.stringify(items) : null;
})()`;
