set +e
BASE=http://127.0.0.1:3000/api
INV=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"username":"investigator1","password":"demo1234","deviceId":"seal"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')
STU=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"username":"student1","password":"demo1234","deviceId":"seal"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')
API=/workspace/apps/api

echo "== 1) 调查员撤回粤语说话人授权（REST /speakers/:id/revoke）"
curl -s -X POST "$BASE/speakers/spk-cantonese-01/revoke" -H "Authorization: Bearer $INV" \
 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log("   consentStatus:",r.consentStatus,"| 本次封口文件数 _sealedFiles:",r._sealedFiles);})'

echo "== 2) 磁盘状态：明文 wav 必须消失，出现 .wav.enc 且不含 RIFF"
if [ -f "$API/uploads/audio/aud-yue-hello.wav" ]; then echo "   失败：明文仍存在"; else echo "   明文已删除 ✓"; fi
ENC="$API/uploads/audio/aud-yue-hello.wav.enc"
if [ -f "$ENC" ]; then
  echo "   密文存在 ✓ ($(stat -c%s "$ENC") bytes)"
  head -c4 "$ENC" | grep -q RIFF && echo "   失败：密文以RIFF开头（像明文）" || echo "   密文不是RIFF ✓"
else echo "   失败：密文缺失"; fi

echo "== 3) 学员无法下载（403），调查员经内存解密读到原文"
curl -s -o /dev/null -w "   student HTTP %{http_code}\n" "$BASE/audio/aud-yue-hello/file" -H "Authorization: Bearer $STU"
curl -s "$BASE/audio/aud-yue-hello/file" -H "Authorization: Bearer $INV" -o /tmp/back.wav -w "   investigator HTTP %{http_code}\n"
head -c4 /tmp/back.wav; echo " <- 解密后应恢复RIFF"

echo "== 4) 元数据状态：sensitive/restricted/keyVersion"
curl -s "$BASE/audio/aud-yue-hello" -H "Authorization: Bearer $INV" \
 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);console.log("   status:",a.status,"sensitive:",a.sensitive,"keyVersion:",a.keyVersion,"filePath:",a.filePath);})'

echo "== 5) research 成都话播种即加密，调查员可解密、学员 403"
ls "$API/uploads/audio/aud-swg-chengdu.wav.enc" >/dev/null 2>&1 && echo "   成都话密文落盘 ✓" || echo "   成都话未加密 ✗"
curl -s -o /dev/null -w "   student 成都话 HTTP %{http_code}（应403）\n" "$BASE/audio/aud-swg-chengdu/file" -H "Authorization: Bearer $STU"
curl -s "$BASE/audio/aud-swg-chengdu/file" -H "Authorization: Bearer $INV" -o /tmp/cd.wav -w "   investigator HTTP %{http_code}\n"
head -c4 /tmp/cd.wav; echo " <- RIFF"
