# SFF Smart Shrimp

PWA สำหรับติดตามคุณภาพน้ำและควบคุมฟาร์มกุ้งขาวขนาดใหญ่ (หลายร้อยบ่อ)

```
[Sensors] → [PLC + HMI] ──Modbus/OPC UA──> [IPC Gateway] ──MQTT/TLS (outbound)──┐
            auto logic, interlock,          buffer + edge rules → siren         │
            siren, Local/Remote                                                 ▼
VPS (Docker): Caddy → api (Express + SSE) │ ingest │ EMQX │ PostgreSQL + TimescaleDB
                                                  │
                                       Web Push / LINE / SMS → PWA
```

**หลักสำคัญ:** การควบคุมที่ชี้เป็นชี้ตาย (DO ต่ำ → เปิดเครื่องตีน้ำ, ไฟดับ, siren) ทำที่ PLC หน้าฟาร์ม
ระบบ cloud ใช้ดูภาพรวม แจ้งเตือน และสั่งงาน manual — เน็ตหลุดหรือ VPS ล่ม ฟาร์มต้องยังทำงานได้

## โครงสร้าง

| Path | หน้าที่ |
|---|---|
| `apps/api` | Express: REST, auth (JWT cookie + role), SSE realtime, เสิร์ฟ PWA, รัน migration |
| `apps/ingest` | MQTT → TimescaleDB แบบ batch, อัปเดต `pond_latest`, NOTIFY ให้ api |
| `apps/simulator` | จำลอง gateway ฟาร์ม 500 บ่อ (ใช้ demo / load test) |
| `apps/web` | PWA (HTML/CSS/vanilla JS modules, uPlot) |
| `packages/shared` | เกณฑ์ค่าน้ำ, การประเมินสถานะบ่อ, MQTT topics — ใช้ร่วมกันทั้ง server และ browser |
| `db/migrations` | schema, hypertable, compression, continuous aggregates, retention |
| `deploy` | docker-compose, Caddyfile, `.env.example` |

## เริ่มใช้งานบนเครื่อง (demo 500 บ่อ)

```sh
cd deploy
cp .env.example .env
# แก้ .env: SITE_ADDRESS=:80  COOKIE_SECURE=false  HTTP_PORT=8080  SEED_DEMO=true และตั้งรหัสผ่านทุกช่อง
docker compose --env-file .env --profile sim up -d --build
```

เปิด http://localhost:8080 แล้วเข้าสู่ระบบด้วย `ADMIN_USER` / `ADMIN_PASSWORD`

Simulator จะส่งข้อมูลย้อนหลัง 48 ชม. แล้วส่งค่าปัจจุบันทุก 10 วินาที และสุ่มให้บางบ่อมีปัญหา
(DO ต่ำ, pH สูง, หัววัด pH เสีย, ขาดการติดต่อ) — บ่อ DO ต่ำจะเป็น "วิกฤต" ช่วงกลางคืนถึงเช้ามืด

ทดสอบ: `npm install && npm test`

## MQTT contract (สำหรับ gateway ฟาร์ม)

| Topic | QoS / retain | Payload |
|---|---|---|
| `sff/{farm}/{pond}/telemetry` | 1 | `{"ts":"2026-01-01T10:00:00+07:00","do":5.2,"ph":7.9,"orp":250,"temp":29.1}` หรือ batch `{"samples":[{...,"backfill":true}]}` |
| `sff/{farm}/{pond}/state` | 1, retain | `{"ts":...,"mode":"remote","devices":[{"code":"AE1","on":true,"current_a":12.1,"fault":false}]}` |
| `sff/{farm}/gateway/status` | 1, retain, **LWT** | `{"online":true}` (LWT: `{"online":false}`) |
| `sff/{farm}/{pond}/cmd` | 1, **ห้าม retain** | (เฟสควบคุมอุปกรณ์) `{"id":"uuid","device":"AE1","action":"on","expires_at":...}` |
| `sff/{farm}/{pond}/cmd/ack` | 1 | (เฟสควบคุมอุปกรณ์) |

- `ts` ต้องเป็นเวลาที่วัดจริงจากต้นทาง (ตั้ง NTP ที่ IPC/PLC) — ส่งซ้ำได้ ระบบตัดข้อมูลซ้ำด้วย `(pond_id, time)`
- Gateway ควรเก็บข้อมูลไว้ตอนเน็ตหลุดแล้วส่งย้อนหลังเป็น batch พร้อม `"backfill": true` (รับย้อนหลังได้ 30 วัน)
- `device_state` คือสถานะจริงจาก feedback ของ PLC (aux contact / กระแสมอเตอร์) ไม่ใช่ "สั่งแล้ว"

## Production (VPS)

1. ตั้ง DNS ชี้มาที่ VPS, คัดลอก `deploy/` ไปที่ `~/sff/deploy`, สร้าง `.env` จาก `.env.example` (`SEED_DEMO=false`)
2. ทำตาม [deploy/emqx/README.md](deploy/emqx/README.md): เปิด authentication + ACL และใช้ TLS (8883) เท่านั้น
3. `docker compose --env-file .env up -d`
4. ตั้ง GitHub secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` แล้ว push tag `v*` เพื่อ deploy อัตโนมัติ
   (ถ้า image ใน GHCR เป็น private ให้ `docker login ghcr.io` บน VPS ก่อน)
5. **Backup ฐานข้อมูลออกนอก VPS** ทุกวัน เช่น
   `docker compose exec -T db pg_dump -U sff -Fc sff > sff-$(date +%F).dump` แล้วส่งขึ้น object storage

## สถานะงาน

- [x] Foundation: compose, schema + Timescale policies, auth/RBAC, CI
- [x] Ingest + simulator + หน้าภาพรวม (grid หลายร้อยบ่อ) + หน้ารายละเอียดบ่อ (realtime ผ่าน SSE)
- [ ] บันทึกค่าน้ำ / ผล lab / รอบการเลี้ยง แบบ offline-first
- [ ] Alert engine: rules + hold time, Web Push + LINE + SMS, ack + escalation
- [ ] สั่งงานอุปกรณ์: cmd → ack → state, หมดอายุคำสั่ง, Local/Remote, audit log
- [ ] Edge agent บน IPC: Modbus/OPC UA → MQTT, buffer, siren (รอข้อมูลรุ่น PLC)
