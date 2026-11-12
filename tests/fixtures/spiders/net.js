/**
 * JS `req` capability probe (ESM): reports status / length / head for one http
 * and one https target. Used by the P1 probe and by manual diagnosis when a
 * real JS source returns empty pages — it separates "script ran" from "network
 * request actually fetched content".
 */
async function home() {
  const probe = {};
  try {
    const a = await req("http://asp.xpgtv.com/api.php/v2.vod/androidtypes", {
      headers: { "User-Agent": "okhttp/3.12.11" },
    });
    probe.http = {
      code: a.code,
      len: String(a.content || "").length,
      head: String(a.content || "").slice(0, 80),
      err: a.error || "",
    };
  } catch (e) {
    probe.http = { threw: String(e) };
  }
  try {
    const b = await req(
      "https://raw.githubusercontent.com/cluntop/tvbox/a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8/box.json",
      {},
    );
    probe.https = {
      code: b.code,
      len: String(b.content || "").length,
      head: String(b.content || "").slice(0, 40),
      err: b.error || "",
    };
  } catch (e) {
    probe.https = { threw: String(e) };
  }
  return { list: [], probe };
}

function init(ext) {}

export default { init, home };
