set +e
BASE=http://127.0.0.1:3000/api
login() { curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"demo1234\",\"deviceId\":\"poison\"}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))'; }
STU=$(login student1)
INV=$(login investigator1)

echo "== 攻击前：基线游标（当前时间量级）"
BASE_CURSOR=$(curl -s "$BASE/sync/pull" -H "Authorization: Bearer $INV" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);console.log(p.cursor);})')
node -e 'console.log("   基线游标:",process.argv[1])' "$BASE_CURSOR"

echo "== 学员推送 updatedAt=2999 年的毒记录"
curl -s -X POST "$BASE/sync/push" -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d '{
 "deviceId":"evil-clock",
 "attempts":[{"baseVersion":0,"entity":{
   "id":"att-poison-1","studentId":"usr-student-01","courseItemId":"crs-dialect101-item-1","audioId":"aud-yue-hello",
   "durationSec":1.5,"mime":"audio/wav","waveformPeaks":[0.2],"score":null,
   "createdAt":"2999-01-01T00:00:00.000Z","version":1,"updatedAt":"2999-01-01T00:00:00.000Z"}}]}' \
 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log("   accepted:",JSON.stringify(r.accepted),"conflicts:",r.conflicts.length);})'

echo "== 修复后：全服游标不得跳到未来"
NEW_CURSOR=$(curl -s "$BASE/sync/pull" -H "Authorization: Bearer $INV" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);console.log(p.cursor);})')
node -e 'const b=Date.parse(process.argv[1]),n=Date.parse(process.argv[2]);const now=Date.now();
console.log("   新游标:",process.argv[2]);
console.log("   游标在现在附近（±6分钟）?",Math.abs(n-now)<6*60*1000);
console.log("   远小于2999年?",n<Date.parse("2027-01-01"));' "$BASE_CURSOR" "$NEW_CURSOR"

echo "== 毒记录的 updatedAt 已被钳制（库里不是2999年）"
curl -s "$BASE/practice/attempts" -H "Authorization: Bearer $(login coach1)" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);const t=a.find(x=>x.id==="att-poison-1");console.log("   updatedAt:",t?.updatedAt,"年份:",new Date(t?.updatedAt).getUTCFullYear());})'

echo "== 毒记录之后，用旧游标增量拉取仍能收到它（系统未坏）"
OLD=$(node -e 'console.log(new Date(Date.now()-60000).toISOString())')
curl -s "$BASE/sync/pull?cursor=$OLD" -H "Authorization: Bearer $STU" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);console.log("   学员本人能拉到毒记录:",p.attempts.some(a=>a.id==="att-poison-1"));})'

echo "== 已中毒的客户端（持2999游标）本轮自愈，且之后新数据可达"
curl -s "$BASE/sync/pull?cursor=2999-01-01T00:00:00.000Z" -H "Authorization: Bearer $INV" \
 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);const now=Date.now();console.log("   返回游标已钳到现在附近:",Math.abs(Date.parse(p.cursor)-now)<6*60*1000);})'

echo "== 调查员再推一条正常新说话人（毒记录之后的合法新数据）"
curl -s -X POST "$BASE/sync/push" -H "Authorization: Bearer $INV" -H 'Content-Type: application/json' -d "{
 \"deviceId\":\"normal\",\"speakers\":[{\"baseVersion\":0,\"entity\":{
   \"id\":\"spk-after-poison\",\"code\":\"AFTER-1\",\"name\":\"毒后新增\",\"dialect\":\"粤语\",\"region\":\"广州\",
   \"consentStatus\":\"granted\",\"consentScope\":\"course\",\"version\":1,\"updatedAt\":\"$(node -e 'console.log(new Date().toISOString())')\"}}]}" \
 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log("   accepted:",JSON.parse(d).accepted))'
OLD=$(node -e 'console.log(new Date(Date.now()-10000).toISOString())')
curl -s "$BASE/sync/pull?cursor=$OLD" -H "Authorization: Bearer $INV" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);console.log("   旧游标能拉到毒后新数据:",p.speakers.some(s=>s.id==="spk-after-poison"));})'
