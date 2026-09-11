set +e
BASE=http://127.0.0.1:3000/api
INV=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"username":"investigator1","password":"demo1234","deviceId":"res"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')
API=/workspace/apps/api
AID="aud-research-new-$RANDOM"

echo "== 1) 调查员为 research 说话人（成都话 spk-southwestern-01）创建新素材元数据"
curl -s -o /dev/null -w "   POST /audio HTTP %{http_code}\n" -X POST "$BASE/audio" -H "Authorization: Bearer $INV" -H 'Content-Type: application/json' -d "{
 \"id\":\"$AID\",\"title\":\"山区新录的研究素材\",\"speakerId\":\"spk-southwestern-01\",\"ownerId\":\"usr-investigator-01\",
 \"dialect\":\"西南官话-成渝片-成都话\",\"durationSec\":1,\"sampleRate\":44100,\"channels\":1,\"mime\":\"audio/wav\",
 \"waveformPeaks\":[0.3],\"syllables\":[],\"status\":\"annotated\",\"sensitive\":false,
 \"recordedAt\":\"2026-09-11T10:00:00Z\",\"version\":1,\"updatedAt\":\"2026-09-11T10:00:00Z\"}"

echo "== 2) 上传明文 WAV 字节（模拟录音同步）"
printf 'RIFF\x00\x00\x00\x00WAVE-new-field-research-audio' > /tmp/new.wav
curl -s -o /dev/null -w "   POST file HTTP %{http_code}\n" -X POST "$BASE/audio/$AID/file" -H "Authorization: Bearer $INV" -F "file=@/tmp/new.wav;type=audio/wav"

echo "== 3) 磁盘检查：必须只有 .wav.enc，从无明文 wav"
ls -la "$API/uploads/audio/$AID".* 2>/dev/null | awk '{print "  ",$NF,$5"bytes"}'
if [ -f "$API/uploads/audio/$AID.wav" ]; then echo "   ✗ 明文落盘（漏洞仍在）"; else echo "   ✓ 无明文文件"; fi
ENC="$API/uploads/audio/$AID.wav.enc"
if [ -f "$ENC" ]; then
  grep -q "new-field-research-audio" "$ENC" && echo "   ✗ 密文含明文字符串" || echo "   ✓ 密文不含明文录音内容"
  head -c4 "$ENC" | grep -q RIFF && echo "   ✗ 以RIFF开头（像明文）" || echo "   ✓ 非RIFF头"
fi

echo "== 4) 元数据：keyVersion=1, filePath=.enc"
curl -s "$BASE/audio/$AID" -H "Authorization: Bearer $INV" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);console.log("   filePath:",a.filePath,"keyVersion:",a.keyVersion);})'

echo "== 5) 调查员内存解密可读；教练/学员 403"
curl -s "$BASE/audio/$AID/file" -H "Authorization: Bearer $INV" -o /tmp/back.bin -w "   investigator HTTP %{http_code}\n"
head -c4 /tmp/back.bin; echo " <- 应恢复RIFF"
CO=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"username":"coach1","password":"demo1234","deviceId":"res"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')
STU=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"username":"student1","password":"demo1234","deviceId":"res"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')
curl -s -o /dev/null -w "   coach  HTTP %{http_code}（应403）\n" "$BASE/audio/$AID/file" -H "Authorization: Bearer $CO"
curl -s -o /dev/null -w "   student HTTP %{http_code}（应403）\n" "$BASE/audio/$AID/file" -H "Authorization: Bearer $STU"

echo "== 6) 对照组：course 说话人（粤语）新录音仍为明文"
CID="aud-course-new-$RANDOM"
curl -s -o /dev/null -X POST "$BASE/audio" -H "Authorization: Bearer $INV" -H 'Content-Type: application/json' -d "{
 \"id\":\"$CID\",\"title\":\"课程新素材\",\"speakerId\":\"spk-cantonese-01\",\"ownerId\":\"usr-investigator-01\",
 \"dialect\":\"粤语\",\"durationSec\":1,\"sampleRate\":44100,\"channels\":1,\"mime\":\"audio/wav\",
 \"waveformPeaks\":[0.3],\"syllables\":[],\"status\":\"annotated\",\"sensitive\":false,
 \"recordedAt\":\"2026-09-11T10:01:00Z\",\"version\":1,\"updatedAt\":\"2026-09-11T10:01:00Z\"}"
printf 'RIFF\x00\x00\x00\x00WAVE-course-ok-audio' > /tmp/c.wav
curl -s -o /dev/null -X POST "$BASE/audio/$CID/file" -H "Authorization: Bearer $INV" -F "file=@/tmp/c.wav;type=audio/wav"
[ -f "$API/uploads/audio/$CID.wav" ] && echo "   ✓ 课程素材明文落盘（符合策略）" || echo "   ✗ 课程素材异常加密"
