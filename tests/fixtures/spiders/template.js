/**
 * Self-made JS spider template for P1 acceptance (spec T-16).
 *
 * Runs inside the qjs-runner sidecar with only `req` and `local` injected;
 * anything else (require, process, fetch) must be absent. All URLs point at the
 * local stub server.
 */
var BASE = "http://127.0.0.1:8787";

function vod(id, name) {
  return {
    vod_id: id,
    vod_name: name,
    vod_pic: BASE + "/poster.jpg",
    vod_remarks: "JS 模板",
    type_name: "JS 分类",
    vod_play_from: "js",
    vod_play_url: "第1集$" + BASE + "/play.m3u8",
  };
}

function page(list, extra) {
  var out = {
    list: list,
    page: 1,
    pagecount: 1,
    limit: 20,
    total: list.length,
  };
  if (extra) {
    for (var key in extra) {
      out[key] = extra[key];
    }
  }
  return out;
}

var spider = {
  init: function (ext) {
    this.ext = ext || "";
  },
  homeContent: function (filter) {
    return page([vod("js-1", "JS 首页影片")], {
      class: [{ type_id: "js_home", type_name: "JS 分类" }],
      ext: this.ext,
    });
  },
  homeVideoContent: function () {
    return { list: [] };
  },
  categoryContent: function (tid, pg, filter, extend) {
    return page([vod("js-" + tid + "-" + pg, "JS 分类 " + tid + " 第 " + pg + " 页")]);
  },
  detailContent: function (ids) {
    var id = ids && ids.length ? ids[0] : "js-1";
    return { list: [vod(id, "JS 详情 " + id)] };
  },
  searchContent: function (key, quick, pg) {
    return page([vod("js-search-" + key, "JS 搜索 " + key)]);
  },
  playerContent: function (flag, id, vipFlags) {
    return {
      parse: 0,
      url: BASE + "/play.m3u8",
      header: { Referer: BASE + "/" },
      flag: flag,
      ext: this.ext,
    };
  },
  liveContent: function (url) {
    return { class: [], list: [] };
  },
  /**
   * TVBox local proxy (`/proxy?do=js`). Sources hand back
   * `getProxyUrl() + "&do=js&..."` URLs, so this method is called with the raw
   * query map and answers `[contentType, headers, body]`.
   */
  proxy: function (params) {
    var query = params || {};
    var target = query.url || "";
    return [
      "application/vnd.apple.mpegurl",
      { "x-js-proxy": "template" },
      "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2,\n" + target + "\n",
    ];
  },
};

globalThis.spider = spider;
