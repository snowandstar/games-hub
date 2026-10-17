#!/usr/bin/env bash
#
# scripts/verify.sh — games-hub 部署后验收（对应 docs/site-spec.md §10）
#
# 用法：
#   GHUB_BASE=https://lhm666888.dpdns.org \
#   GHUB_GATE=<门禁 cookie> GHUB_TOKEN=<登录 token> \
#   bash scripts/verify.sh
#
# GHUB_BASE 默认 https://lhm666888.dpdns.org；其余不传就用占位符，
# 需要登录态的断言会标 SKIP 而不是假装通过（设 STRICT=1 可把 SKIP 当失败）。
#
# ---------------------------------------------------------------------------
# 两个凭据怎么拿（都不写进仓库，只放环境变量）：
#
# 1) ghub_gate（页面门禁 cookie，HttpOnly，JS 读不到，只能这样取）
#    a. curl 登录，从响应头里抠：
#       curl -i -X POST "$GHUB_BASE/api/auth/login" \
#            -H 'Content-Type: application/json' \
#            -d '{"username":"你的用户名","password":"你的密码"}'
#       → 响应头 Set-Cookie: ghub_gate=xxxxx; ... 取等号后第一段
#    b. 或 DevTools → Application → Cookies → $GHUB_BASE → ghub_gate
#    格式：base64url(username).<过期毫秒时间戳>.<base64url(HMAC)>
#
# 2) ghub_token（API 的 Bearer token，存在 localStorage）
#    a. DevTools → Console → 执行：copy(localStorage.getItem('ghub_token'))
#    b. 或上面那个登录响应体里的 "token" 字段
#       curl -s -X POST "$GHUB_BASE/api/auth/login" \
#            -H 'Content-Type: application/json' \
#            -d '{"username":"...","password":"..."}' | grep -o '"token":"[^"]*"'
# ---------------------------------------------------------------------------

set -uo pipefail

BASE="${GHUB_BASE:-https://lhm666888.dpdns.org}"
BASE="${BASE%/}"
GATE="${GHUB_GATE:-<GATE>}"
TOKEN="${GHUB_TOKEN:-<TOKEN>}"
STRICT="${STRICT:-0}"

# 首页卡片数与 404 页体积上限（首页实测 28989 字节，404 页必须远小于它）
CARD_MIN=9
MAX_404_SIZE=20000
TTFB_MAX="${TTFB_MAX:-2.00}"

PASS=0
FAIL=0
SKIP=0
FAILED_ITEMS=()

ok()  { printf 'PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
ng()  { printf 'FAIL  %s\n        %s\n' "$1" "$2"; FAIL=$((FAIL + 1)); FAILED_ITEMS+=("$1 — $2"); }
sk()  { printf 'SKIP  %s\n        %s\n' "$1" "$2"; SKIP=$((SKIP + 1)); }

have_cred() { # 值里带尖括号说明还是占位符
  case "$1" in
    ""|*"<"*|*">"*) return 1 ;;
    *) return 0 ;;
  esac
}

printf '== games-hub 部署验收 ==\n'
printf 'BASE = %s\n\n' "$BASE"

# ---------------------------------------------------------------------------
# 1. 页面门禁：无 cookie 必须 302 到 /login?next=
#    例外（设计如此，不是缺陷）：
#      /login      —— 登录页本身必须匿名可达，否则永远登不进去
#                    （注意测 /login 而不是 /login.html：Pages 会把带 .html 的
#                      路径 308 到无扩展名形式，那是平台行为不是缺陷）
#      /404.html   —— 真 404 页，返回 404 而不是 302
# ---------------------------------------------------------------------------
printf -- '-- 1. 页面门禁（无 cookie）--\n'
check_page() {
  local path="$1" want="$2"
  local code loc
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path")
  loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE$path")
  if [ "$code" != "$want" ]; then
    ng "页面 $path" "期望 $want，实际 $code"
    return
  fi
  if [ "$want" = "302" ]; then
    case "$loc" in
      */login\?next=*) ok "页面 $path → 302 /login?next=…" ;;
      *) ng "页面 $path" "是 302，但 Location 不是 /login?next=，实际「${loc}」" ;;
    esac
  else
    ok "页面 $path → $code"
  fi
}
check_page "/"                      302
check_page "/index.html"            302
check_page "/game.html"             302
check_page "/account.html"          302
check_page "/ai-admin.html"         302
check_page "/tools.html"            302
check_page "/media.html"            302
check_page "/guestbook.html"        302
check_page "/game2048.html"         302
check_page "/minesweeper.html"      302
check_page "/snake.html"            302
check_page "/minecraft.html"        302
check_page "/minecraft-1122.html"   302
check_page "/minecraft-125.html"    302
check_page "/minecraft-classic.html" 302
check_page "/login"                 200
check_page "/404.html"              404
printf '\n'

# ---------------------------------------------------------------------------
# 2. 静态资源：无 cookie 必须 200（不是 302），Content-Type 正确
# ---------------------------------------------------------------------------
printf -- '-- 2. 静态资源（无 cookie，不能被门禁挡）--\n'
check_asset() {
  local path="$1" want_ct="$2"
  local code ct
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path")
  ct=$(curl -s -o /dev/null -w '%{content_type}' "$BASE$path")
  if [ "$code" != "200" ]; then
    ng "资源 $path" "期望 200（被门禁挡成 $code 就是回归），实际 $code"
    return
  fi
  case "$ct" in
    "$want_ct"*) ok "资源 $path → 200 $ct" ;;
    *) ng "资源 $path" "Content-Type 期望 ${want_ct}*，实际 $ct" ;;
  esac
}
check_asset "/games.json"  "application/json"
check_asset "/default.svg" "image/svg+xml"
check_asset "/bh32.jpg"    "image/jpeg"
check_asset "/bh33.jpg"    "image/jpeg"
printf '\n'

# ---------------------------------------------------------------------------
# 3. robots.txt：200 + text/plain + 内容正确
# ---------------------------------------------------------------------------
printf -- '-- 3. robots.txt --\n'
rb_code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/robots.txt")
rb_ct=$(curl -s -o /dev/null -w '%{content_type}' "$BASE/robots.txt")
rb_body=$(curl -s "$BASE/robots.txt")
if [ "$rb_code" != "200" ]; then
  ng "robots.txt" "期望 200，实际 $rb_code"
elif [ "$rb_ct" != "text/plain" ] && [ "$rb_ct" != "text/plain; charset=utf-8" ]; then
  ng "robots.txt" "Content-Type 期望 text/plain，实际 $rb_ct（返回 HTML 就是软 404 回归）"
elif ! printf '%s' "$rb_body" | grep -q 'User-agent: \*'; then
  ng "robots.txt" "内容缺 User-agent: *"
elif ! printf '%s' "$rb_body" | grep -q 'Disallow: /'; then
  ng "robots.txt" "内容缺 Disallow: /"
else
  ok "robots.txt → 200 $rb_ct + User-agent: * / Disallow: /"
fi
printf '\n'

# ---------------------------------------------------------------------------
# 4. 不存在的路径 / 不该公开的路径 → 真 404，且响应体不是首页
# ---------------------------------------------------------------------------
printf -- '-- 4. 真 404 与发布面收敛 --\n'
check_404() {
  local path="$1"
  local code size body
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path")
  size=$(curl -s -o /dev/null -w '%{size_download}' "$BASE$path")
  body=$(curl -s "$BASE$path")
  if [ "$code" != "404" ]; then
    ng "404：${path}" "期望 404，实际 $code"
    return
  fi
  if [ "${size:-99999}" -ge "$MAX_404_SIZE" ]; then
    ng "404：${path}" "响应体 ${size} 字节，接近首页 28989，疑似又被回落成首页"
    return
  fi
  case "$body" in
    *'class="card'*) ng "404：${path}" "响应体里出现首页卡片，说明不是真 404" ;;
    *) ok "404：${path} → 404（${size} 字节，远小于 28989）" ;;
  esac
}
check_404 "/definitely-not-here"
check_404 "/sitemap.xml"
check_404 "/docs/site-spec.md"
check_404 "/scripts/build.mjs"
check_404 "/_backup/index.html"
printf '\n'

# ---------------------------------------------------------------------------
# 5. 带有效门禁 cookie：200 + 首屏卡片 + TTFB
# ---------------------------------------------------------------------------
printf -- '-- 5. 带有效门禁 cookie --\n'
if ! have_cred "$GATE"; then
  sk "有效 gate 访问 /" "未设置 GHUB_GATE（取值方式见本文件头注释）"
else
  g_code=$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: ghub_gate=$GATE" "$BASE/")
  g_ttfb=$(curl -s -o /dev/null -w '%{time_starttransfer}' -H "Cookie: ghub_gate=$GATE" "$BASE/")
  g_body=$(curl -s -H "Cookie: ghub_gate=$GATE" "$BASE/")
  g_cards=$(printf '%s' "$g_body" | grep -o 'class="card' | wc -l | tr -d ' ')
  if [ "$g_code" != "200" ]; then
    ng "有效 gate 访问 /" "期望 200，实际 $g_code（cookie 过期或签名不对？）"
  else
    ok "有效 gate 访问 / → 200（TTFB ${g_ttfb}s）"
    if [ "${g_cards:-0}" -lt "$CARD_MIN" ]; then
      ng "首屏卡片数" "期望 >= ${CARD_MIN} 张（构建期注入），实际 ${g_cards}"
    else
      ok "首屏卡片数 → ${g_cards} 张（HTML 里就有，非 JS 渲染）"
    fi
    if [ "$(printf '%s' "$g_ttfb" | awk -v m="$TTFB_MAX" '{print ($1+0 > m) ? "over" : "ok"}')" = "over" ]; then
      ng "首页 TTFB" "${g_ttfb}s 超过阈值 ${TTFB_MAX}s（删掉 Worker 的 HTML 改写后应明显下降）"
    else
      ok "首页 TTFB → ${g_ttfb}s（阈值 ${TTFB_MAX}s）"
    fi
  fi
fi
printf '\n'

# ---------------------------------------------------------------------------
# 6. 篡改 / 过期的门禁 cookie → 302（不能放行）
# ---------------------------------------------------------------------------
printf -- '-- 6. 篡改 / 过期 gate --\n'
if ! have_cred "$GATE"; then
  sk "篡改 gate" "未设置 GHUB_GATE"
  sk "过期 gate" "未设置 GHUB_GATE"
else
  u="${GATE%%.*}"
  rest="${GATE#*.}"
  sig="${rest#*.}"
  GATE_BAD="${GATE}z"                       # 改签名最后一个字符
  GATE_EXPIRED="${u}.1700000000000.${sig}"  # exp 换成过去的时间戳（签名也随之失效）
  for pair in "篡改:${GATE_BAD}" "过期:${GATE_EXPIRED}"; do
    label="${pair%%:*}"
    val="${pair#*:}"
    c=$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: ghub_gate=$val" "$BASE/")
    if [ "$c" = "302" ]; then
      ok "${label} gate → 302（未放行）"
    else
      ng "${label} gate" "期望 302，实际 $c（门禁被绕过）"
    fi
  done
fi
printf '\n'

# ---------------------------------------------------------------------------
# 7. API：数据单源 + 预设不泄 key
# ---------------------------------------------------------------------------
printf -- '-- 7. API --\n'
ag_code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/games")
ag_body=$(curl -s "$BASE/api/games")
if [ "$ag_code" != "200" ]; then
  ng "/api/games" "期望 200（播放页还依赖它），实际 $ag_code"
else
  ok "/api/games → 200（数据源 /games.json）"
  if printf '%s' "$ag_body" | grep -q '"id"'; then
    ok "/api/games 返回体含游戏条目"
  else
    ng "/api/games" "返回体里没有 \"id\" 字段，数据可能为空"
  fi
fi

if ! have_cred "$TOKEN"; then
  sk "/api/ai/presets 不泄 key" "未设置 GHUB_TOKEN（取值方式见本文件头注释）"
else
  pr_body=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/ai/presets")
  if [ -z "$pr_body" ]; then
    ng "/api/ai/presets" "空响应"
  elif printf '%s' "$pr_body" | grep -q '"key"'; then
    ng "/api/ai/presets 不泄 key" "响应里出现 \"key\" 字段，API Key 泄露"
  else
    ok "/api/ai/presets 不泄 key → 响应中无 \"key\" 字段"
  fi
fi
printf '\n'

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
printf '== 汇总 ==\n'
printf '通过：%d\n失败：%d\n跳过：%d\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '失败项：\n'
  for it in "${FAILED_ITEMS[@]}"; do printf '  - %s\n' "$it"; done
fi
if [ "$SKIP" -gt 0 ]; then
  printf '注意：有 %d 项因缺少凭据被跳过，补上 GHUB_GATE / GHUB_TOKEN 再跑一次才算验收完整。\n' "$SKIP"
fi

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
if [ "$STRICT" = "1" ] && [ "$SKIP" -gt 0 ]; then
  exit 1
fi
exit 0
