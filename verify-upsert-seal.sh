set +e
BASE=http://127.0.0.1:3000/api
INV=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"username":"investigator1","password":"demo1234","deviceId":"up"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')
STU=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"username":"student1","password":"demo1234","deviceId":"up"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')
API=/workspace/apps/api

echo "== 前置：厦门话素材是明文 wav、说话人 course 授权"
ls -la $API/uploads/audio/aud-nan-xiamen.wav 2>/dev/null | awk '{print "   明文文件存在,",$5,"bytes"}'
head -c4 $API/uploads/audio/aud-nan-xiamen.wav; echo " <- RIFF"

echo "== 攻击向量：直接调通用 PUT /speakers/:id 把授权改为 revoked（不走 /revoke）"
curl -s -X PUT "$BASE/speakers/spk-minnan-01" -H "Authorization: Bearer $INV" -H 'Content-Type: application/json' -d '{
  "id":"spk-minnan-01","code":"NAN-XM-004","name":"林先生（厦门话示例发音人）","gender":"M",
  "dialect":"闽南语-泉漳片-厦门话","region":"福建省厦门市思明区",
  "consentStatus":"revoked","consentScope":null,
  "version":5,"updatedAt":"2026-09-11T10:00:00.000Z"}' \
 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log("   接口返回 consentStatus:",s.consentStatus);})'

sleep 1
echo "== 验证磁盘：明文必须消失、密文出现"
if [ -f "$API/uploads/audio/aud-nan-xiamen.wav" ]; then echo "   ✗ 明文仍存在（漏洞未修）"; else echo "   ✓ 明文已删除"; fi
ENC="$API/uploads/audio/aud-nan-xiamen.wav.enc"
if [ -f "$ENC" ]; then echo "   ✓ 密文已生成 ($(stat -c%s "$ENC") bytes), 前4字节非RIFF:"; head -c4 "$ENC" | grep -qv RIFF && echo "     ✓ 非RIFF"; else echo "   ✗ 密文缺失"; fi

echo "== 验证元数据与访问控制"
curl -s "$BASE/audio/aud-nan-xiamen/file" -H "Authorization: Bearer $STU" -o /dev/null -w "   学员下载 HTTP %{http_code}（应403）\n"
curl -s "$BASE/audio/aud-nan-xiamen" -H "Authorization: Bearer $INV" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);console.log("   status:",a.status,"keyVersion:",a.keyVersion,"filePath:",a.filePath);})'

echo "== 范围缩减：改回 granted+research（通用接口），第二条明文素材也应封口"
curl -s -o /dev/null -X PUT "$BASE/speakers/spk-minnan-01" -H "Authorization: Bearer $INV" -H 'Content-Type: application/json' -d '{
  "id":"spk-minnan-01","code":"NAN-XM-004","name":"林先生","dialect":"闽南语-泉漳片-厦门话","region":"福建省厦门市思明区",
  "consentStatus":"granted","consentScope":"research",
  "version":6,"updatedAt":"2026-09-11T10:05:00.000Z"}'
# xiamen 已经是密文，验证状态保持 restricted→research下仍不可分发即可
curl -s "$BASE/audio/aud-nan-xiamen/file" -H "Authorization: Bearer $STU" -o /dev/null -w "   research 下学员 HTTP %{http_code}（应403）\n"

echo "== 恢复 course 后学员重新可播（文件保留加密）"
curl -s -o /dev/null -X PUT "$BASE/speakers/spk-minnan-01" -H "Authorization: Bearer $INV" -H 'Content-Type: application/json' -d '{
  "id":"spk-minnan-01","code":"NAN-XM-004","name":"林先生","dialect":"闽南语-泉漳片-厦门话","region":"福建省厦门市思明区",
  "consentStatus":"granted","consentScope":"course",
  "version":7,"updatedAt":"2026-09-11T10:10:00.000Z"}'
curl -s "$BASE/audio/aud-nan-xiamen/file" -H "Authorization: Bearer $STU" -o /tmp/back.bin -w "   学员恢复后 HTTP %{http_code}\n"
head -c4 /tmp/back.bin; echo " <- 解密恢复RIFF"
