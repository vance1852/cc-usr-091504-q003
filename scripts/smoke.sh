#!/usr/bin/env bash
set -e
B=http://localhost:3211
j() { node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }

G=$(curl -s -X POST $B/admin/guardians -H 'content-type: application/json' -d '{"name":"家长","phone":"138","emergencyPhone":"139"}')
GT=$(echo "$G" | j token); GID=$(echo "$G" | j id)
SID=$(curl -s -X POST $B/admin/students -H 'content-type: application/json' -d "{\"guardianId\":\"$GID\",\"name\":\"学生\"}" | j id)
A=$(curl -s -X POST $B/admin/staff -H 'content-type: application/json' -d '{"name":"甲老师","role":"teacher"}')
AT=$(echo "$A" | j token); AID=$(echo "$A" | j id)
C=$(curl -s -X POST $B/admin/staff -H 'content-type: application/json' -d '{"name":"乙护士","role":"nurse"}')
CT=$(echo "$C" | j token); CID=$(echo "$C" | j id)

REG=$(curl -s -X POST $B/guardian/medications -H "authorization: Bearer $GT" -H 'content-type: application/json' \
  -d "{\"studentId\":\"$SID\",\"packageCode\":\"BOX-2\",\"labelDrugName\":\"维D\",\"labelDoseText\":\"1粒\",\"expiryDate\":\"2027-01-01\",\"storageRequirement\":\"room_temp\",\"initialQuantity\":10,\"quantityUnit\":\"粒\",\"instruction\":{\"drugName\":\"维D\",\"form\":\"tablet\",\"doseText\":\"1粒\",\"route\":\"oral\",\"scheduledTimes\":[\"17:00\"],\"validFrom\":\"2026-09-01\",\"validUntil\":\"2026-09-30\"}}")
MID=$(echo "$REG" | j medicationId)

echo "== 接收（带幂等头 x2，第二次回放）"
curl -s -X POST $B/staff/medications/$MID/receive -H "authorization: Bearer $AT" -H 'x-idempotency-key: rcv-1' -H 'content-type: application/json' -d '{"packageIntact":true,"storageMet":true}' | j status
curl -s -X POST $B/staff/medications/$MID/receive -H "authorization: Bearer $AT" -H 'x-idempotency-key: rcv-1' -H 'content-type: application/json' -d '{"packageIntact":true,"storageMet":true}' | j replayed

echo "== 双人核对"
curl -s -X POST $B/staff/medications/$MID/verify -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"staff1Id\":\"$AID\",\"staff2Id\":\"$CID\",\"storageMet\":true}" | j result

echo "== 执行 1 粒（剩余 9）"
curl -s -X POST $B/staff/medications/$MID/execute -H "authorization: Bearer $AT" -H 'x-idempotency-key: exe-1' -H 'content-type: application/json' -d '{"scheduledTime":"17:00","administeredQty":1}' | j quantityAfter

echo "== 交接给乙护士（数量必须 9）"
curl -s -X POST $B/staff/medications/$MID/handoff -H "authorization: Bearer $AT" -H 'x-idempotency-key: ho-1' -H 'content-type: application/json' -d "{\"toStaffId\":\"$CID\",\"quantity\":9}" | j toStaffId

echo "== 学生拒绝（差错追加）+ 漏服补报"
curl -s -X POST $B/staff/medications/$MID/incidents -H "authorization: Bearer $CT" -H 'x-idempotency-key: in-1' -H 'content-type: application/json' -d '{"type":"student_refused","detail":"不想吃"}' | j type
curl -s -X POST $B/staff/medications/$MID/incidents -H "authorization: Bearer $CT" -H 'x-idempotency-key: in-2' -H 'content-type: application/json' -d '{"type":"missed_dose","scheduledDate":"2026-09-19","scheduledTime":"17:00","detail":"换班遗漏","occurredAt":"2026-09-19T09:30:00Z"}' | j type

echo "== 退回（乙护士发起）"
curl -s -X POST $B/staff/medications/$MID/return -H "authorization: Bearer $CT" -H 'x-idempotency-key: ret-1' -H 'content-type: application/json' -d '{"note":"周五带回"}' | j returnedQuantity

echo "== 家长视图（状态/确认/通知数）"
curl -s $B/guardian/view -H "authorization: Bearer $GT" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const x=d.students[0];
console.log(JSON.stringify({status:x.status, confirmation:x.confirmation.result, execs:x.recentExecutions.length, incidents:x.recentIncidents.length, notifications:x.notifications.length}, null, 0));"

echo "== 审计视图：交接链 + 授权版本 + 剩余数量"
curl -s $B/staff/medications/$MID/audit -H "authorization: Bearer $AT" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
console.log(JSON.stringify({remaining:d.remainingQuantity, chain:d.custodyChain.map(c=>c.type), authVersions:d.authorizations.length, verifiers:d.authorizations[0].verifications.map(v=>v.staff1Name+'+'+v.staff2Name), execs:d.executions.length, incidents:d.incidents.map(i=>i.type)}, null, 0));"
