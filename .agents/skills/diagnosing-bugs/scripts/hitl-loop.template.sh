#!/usr/bin/env bash
# 人工复现记录模板。复制后修改下方场景，由人工测试者在自己的终端运行：
#   bash hitl-loop.template.sh
# 脚本只收集观察，不启动浏览器、不登录、不执行应用操作。
# 将脱敏后的结果交回代理，由代理结合约定症状判断证据是否充分。
# 正常退出只表示记录完成；RESULT 表示本轮人工观察，不证明根因或修复。

set -euo pipefail

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [完成后按回车] " _
}

capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}

printf '%s\n' '只填写脱敏的单行观察摘要；不要粘贴凭据、聊天正文、简历或完整日志。'
printf '%s\n' '此模板不会自动脱敏。多行材料请先整理为单行摘要，保留关键错误码和原因。'

# --- 按本次已确认的场景修改以下步骤 ---
# 同时修改症状判定和摘要问题；环境版本、合成数据与预期应在复现说明中明确。
step "在约定的隔离测试环境中打开应用，准备合成数据。"
step "点击‘导出’，观察是否出现本次约定的错误；环境不可用时选择‘无法判断’。"

while true; do
  capture OBSERVED "约定的错误是否出现？y=已复现，n=操作完成且未复现，u=无法判断"
  case "$OBSERVED" in
    y) RESULT=reproduced; break ;;
    n) RESULT=not_reproduced; break ;;
    u) RESULT=unknown; break ;;
    *) printf '%s\n' '请输入 y、n 或 u。' ;;
  esac
done

capture SUMMARY "填写脱敏的单行结果摘要；无法判断时写明阻碍，没有补充填‘无’："
# --- 场景修改结束 ---

printf '\n--- 人工观察 ---\n'
printf 'RESULT=%s\n' "$RESULT"
printf 'SUMMARY=%s\n' "$SUMMARY"
