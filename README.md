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

## ผังฟาร์ม

- ฟาร์มแบ่งเป็น **Unit** โดย 1 Unit = 1 ระบบ **RAS** (น้ำหมุนเวียนที่ใช้ร่วมกัน) มีบ่อได้ 1–10 บ่อ
- รหัส: Unit `U01`…, บ่อ `U01-P01`…
- หัววัดแยกตามตำแหน่ง

| ตำแหน่ง | หัววัด | ค่า (คอลัมน์) |
|---|---|---|
| บ่อ | DO | `do_mgl` (mg/L), `do_pct` (% อิ่มตัว), `temp_c` |
| RAS ของ Unit | pH | `ph` (0–14), `temp_c` |
| RAS ของ Unit | ORP | `orp_mv` (−2000…2000 mV) |

สถานะบ่อคิดจาก DO และอุณหภูมิของบ่อ ส่วนสถานะ RAS คิดจาก pH, ORP และอุณหภูมิ แยกกัน
หน้าภาพรวมแสดงสถานะ RAS ที่หัวการ์ด Unit และนับแยกเป็น "RAS ผิดปกติ"

**หลักสำคัญ:** การควบคุมที่ชี้เป็นชี้ตาย (DO ต่ำ → เปิดเครื่องตีน้ำ, ไฟดับ, siren) ทำที่ PLC หน้าฟาร์ม
ระบบ cloud ใช้ดูภาพรวม แจ้งเตือน และสั่งงาน manual — เน็ตหลุดหรือ VPS ล่ม ฟาร์มต้องยังทำงานได้

## โครงสร้าง

| Path | หน้าที่ |
|---|---|
| `apps/api` | Express: REST, auth (JWT cookie + role), SSE realtime, เสิร์ฟ PWA, รัน migration |
| `apps/api/src/alerter.js` | service `alerter`: ตรวจเกณฑ์ + เวลายืนยัน, เปิด/ปิด alarm, Web Push, ส่งซ้ำ/ส่งต่อ |
| `apps/ingest` | MQTT → TimescaleDB แบบ batch, อัปเดต `pond_latest`, NOTIFY ให้ api |
| `apps/simulator` | จำลอง gateway ฟาร์ม: RAS ทุก Unit และหัววัด DO ทุกบ่อ (ใช้ demo / load test) |
| `apps/web` | PWA (HTML/CSS/vanilla JS modules, uPlot) |
| `packages/shared` | เกณฑ์ค่าน้ำ, การประเมินสถานะบ่อ, MQTT topics — ใช้ร่วมกันทั้ง server และ browser |
| `db/migrations` | schema (`units`, `ponds`, `sensor_readings`, `ras_readings`, …), hypertable, compression, continuous aggregates, retention |
| `deploy` | docker-compose, Caddyfile, `.env.example` |

## เริ่มใช้งานบนเครื่อง (demo 12 Unit)

```sh
cd deploy
cp .env.example .env
# แก้ .env: SITE_ADDRESS=:80  COOKIE_SECURE=false  HTTP_PORT=8080  SEED_DEMO=true และตั้งรหัสผ่านทุกช่อง
docker compose --env-file .env --profile sim up -d --build
```

เปิด http://localhost:8080 แล้วเข้าสู่ระบบด้วย `ADMIN_USER` / `ADMIN_PASSWORD`

Seed สร้าง 12 Unit มีบ่อ Unit ละ 4–6 บ่อ (`SEED_UNITS`, `SEED_PONDS_MIN`, `SEED_PONDS_MAX`)
Simulator ส่งข้อมูลย้อนหลัง 48 ชม. แล้วส่งค่าปัจจุบันทุก 10 วินาที และกำหนดกรณีผิดปกติไว้ตายตัว

- บ่อ: `U02-P02` DO ต่ำวิกฤตช่วงกลางคืน, `U05-P03` และ `U08-P01` DO ก้ำกึ่ง, `U10-P04` ขาดการติดต่อ, `U12-P02` ไม่มีค่า DO %
- RAS: `U03` pH สูง, `U06` ORP ต่ำ, `U09` หัววัด pH เสีย, `U11` ขาดการติดต่อ

ทดสอบ: `npm install && npm test`

## MQTT contract (สำหรับ gateway ฟาร์ม)

| Topic | QoS / retain | Payload |
|---|---|---|
| `sff/{farm}/{pond}/telemetry` | 1 | หัววัด DO ในบ่อ: `{"ts":"2026-01-01T10:00:00+07:00","do":5.2,"do_pct":71,"temp":29.1}` หรือ batch `{"samples":[{...,"backfill":true}]}` |
| `sff/{farm}/{unit}/ras/telemetry` | 1 | หัววัด RAS ของ Unit: `{"ts":...,"ph":7.9,"orp":250,"temp":29.0}` หรือ batch แบบเดียวกัน |
| `sff/{farm}/{pond}/state` | 1, retain | `{"ts":...,"mode":"remote","devices":[{"code":"AE1","on":true,"current_a":12.1,"fault":false}]}` |
| `sff/{farm}/gateway/status` | 1, retain, **LWT** | `{"online":true}` (LWT: `{"online":false}`) |
| `sff/{farm}/{pond}/cmd` | 1, **ห้าม retain** | (เฟสควบคุมอุปกรณ์) `{"id":"uuid","device":"AE1","action":"on","expires_at":...}` |
| `sff/{farm}/{pond}/cmd/ack` | 1 | (เฟสควบคุมอุปกรณ์) |

- `{pond}` คือรหัสบ่อ เช่น `U01-P01` และ `{unit}` คือรหัส Unit เช่น `U01`
- `ts` ต้องเป็นเวลาที่วัดจริงจากต้นทาง (ตั้ง NTP ที่ IPC/PLC) — ส่งซ้ำได้ ระบบตัดข้อมูลซ้ำด้วย `(pond_id, time)` และ `(unit_id, time)`
- Gateway ควรเก็บข้อมูลไว้ตอนเน็ตหลุดแล้วส่งย้อนหลังเป็น batch พร้อม `"backfill": true` (รับย้อนหลังได้ 30 วัน)
- `device_state` คือสถานะจริงจาก feedback ของ PLC (aux contact / กระแสมอเตอร์) ไม่ใช่ "สั่งแล้ว"

## บันทึกข้อมูลหน้างาน (ใช้ได้ตอนไม่มีสัญญาณ)

เมนู **บันทึก** (`#/manual`) มี 5 แบบ

| แบบ | บันทึกที่ | ใครบันทึกได้ | ตาราง |
|---|---|---|---|
| ให้อาหาร (kg, ชนิดอาหาร, เช็คยอ) | บ่อ (รอบที่กำลังเลี้ยง) | ทุก role | `feedings` |
| ค่าน้ำชุดทดสอบ (อัลคาไลน์, ความเค็ม, TAN, NO₂, ความกระด้าง, Ca, Mg) | **RAS ของ Unit** (น้ำใช้ร่วมกัน) | ทุก role | `manual_readings` |
| สุ่มน้ำหนัก (ABW, จำนวนที่สุ่ม, อัตรารอด) | บ่อ (รอบที่กำลังเลี้ยง) | ทุก role | `growth_samples` |
| ผล Lab (Vibrio เขียว/เหลือง, EHP, AHPND, WSSV) | น้ำ RAS ของ Unit หรือ ตัวอย่างกุ้งจากบ่อ | ทุก role | `lab_results` |
| รอบการเลี้ยง (ลงกุ้ง / จับกุ้ง / ยกเลิกรอบ) | บ่อ | manager ขึ้นไป | `crop_cycles` |

- ทุกรายการบันทึกลง IndexedDB ในเครื่องก่อน (outbox) แล้วส่งไป `POST /api/records` ทันทีถ้ามีสัญญาณ ถ้าไม่มีจะส่งเองเมื่อกลับมาออนไลน์ / เปิดแอปขึ้นมาอีกครั้ง / ทุก 1 นาที
- แต่ละรายการมี `clientId` (UUID) ที่สร้างในเครื่อง ส่งซ้ำกี่ครั้งก็ไม่เกิดข้อมูลซ้ำ (เซิร์ฟเวอร์ตอบ `duplicate`)
- รายการที่เซิร์ฟเวอร์ไม่รับ (เช่น ให้อาหารบ่อที่ปิดรอบไปแล้ว) จะขึ้น "ส่งไม่สำเร็จ" พร้อมเหตุผล และไม่ส่งซ้ำ ผู้ใช้กดลบทิ้งเองได้
- รายการจะส่งในนามผู้บันทึกเท่านั้น ถ้าเปลี่ยนผู้ใช้ในเครื่องเดียวกัน รายการของคนเดิมจะรอจนคนนั้นเข้าสู่ระบบอีกครั้ง
- เปิดแอปตอนไม่มีสัญญาณได้ ถ้าเคยเข้าสู่ระบบและเปิดหน้าภาพรวมตอนออนไลน์มาก่อน (รายชื่อบ่อ/Unit มาจาก cache)
- manager ขึ้นไปลบรายการที่ส่งแล้วได้ (`DELETE /api/records/{type}/{clientId}`) ทุกการลบและการเปิด/ปิดรอบบันทึกใน `audit_log`
- ช่วงค่าแนะนำในฟอร์มเป็นค่าเริ่มต้นสำหรับกุ้งขาว ใช้แสดงผลเท่านั้น การแจ้งเตือนจากค่าที่บันทึกมือจะมาพร้อม Alert engine

## การแจ้งเตือน (Alert engine)

service `alerter` (image เดียวกับ api) ตรวจข้อมูลทุก 10 วินาที แล้วแจ้งผ่าน **Web Push** และในแอป (ตัวเลขบนเมนู + เสียงเตือนตอนเปิดแอป) ไม่ใช้ LINE / SMS

| แหล่ง | เงื่อนไข | ระดับ |
|---|---|---|
| หัววัด DO / อุณหภูมิในบ่อ (เฉพาะบ่อที่มีรอบเลี้ยง) | ผิดเกณฑ์ต่อเนื่องเท่ากับ "เวลายืนยัน" (DO 2 นาที, อื่นๆ 5 นาที) | ตามเกณฑ์ เตือน / วิกฤต |
| หัววัด RAS (pH / ORP / อุณหภูมิ) | เหมือนกัน | ตามเกณฑ์ |
| ส่งข้อมูลมา แต่ค่าหนึ่งหายไป | หัววัดเสีย | เตือน |
| บ่อ / RAS ไม่มีข้อมูลเกิน 5 นาที | | เตือน |
| Gateway ฟาร์มหลุด (MQTT LWT) | 1 นาที — แจ้งครั้งเดียวทั้งฟาร์ม ไม่แจ้งทีละบ่อ | วิกฤต |
| ค่าน้ำชุดทดสอบนอกช่วงแนะนำ | ผลล่าสุดของค่านั้น ปิดเมื่อวัดได้ค่าปกติ | เตือน |
| ผล Lab Vibrio เกินเกณฑ์ / PCR บวก | ปิดเมื่อมีคนกดรับทราบ | เตือน / วิกฤต |

- **ใครได้รับ:** วิกฤตส่งถึงทุก role ส่วนเตือนส่งถึง technician, manager, owner
- **ส่งซ้ำ / ส่งต่อ:** วิกฤตที่ยังไม่มีคนกด "รับทราบ" ส่งซ้ำทุก 5 นาที (`ALERT_CRIT_REPEAT_MIN`) ส่วนเตือนที่ไม่มีคนรับทราบใน 30 นาที ส่งต่อถึง manager / owner (`ALERT_WARN_ESCALATE_MIN`)
- **กดรับทราบ:** กดได้จากหน้าแจ้งเตือน หรือจากปุ่ม "รับทราบ" บนการแจ้งเตือนของเครื่อง ทุกการกดบันทึกใน `audit_log` ส่วนประวัติการส่งเก็บใน `alarm_notifications`
- **กลับเป็นปกติ:** ต้องปกติต่อเนื่อง 1 นาทีจึงปิดการแจ้งเตือน ถ้าเป็นวิกฤตจะส่ง "กลับสู่ปกติ" แบบเงียบ
- **แก้เกณฑ์:** แก้เกณฑ์และเวลายืนยันได้ที่ **ตั้งค่า** (manager ขึ้นไป) มีผลทันทีกับสีบ่อและการแจ้งเตือน
- **ถ้า alerter หยุด:** แอปขึ้นแถบแดง "ระบบแจ้งเตือนหยุดทำงาน" (ไม่มี heartbeat เกิน 90 วินาที)
- **รีสตาร์ท alerter:** ปัญหาที่ยังไม่เปิด alarm จะเริ่มนับเวลายืนยันใหม่ ส่วน alarm ที่เปิดอยู่แล้วไม่ถูกส่งซ้ำ

**เปิดรับการแจ้งเตือนบนมือถือ** (ทำทุกเครื่อง): ไปที่ ตั้งค่า → "เปิดรับการแจ้งเตือน" แล้วกด "ส่งการแจ้งเตือนทดสอบ"
- Android / คอมพิวเตอร์: Chrome หรือ Edge ใช้ได้เลย ต้องเป็น HTTPS (ยกเว้น localhost)
- iPhone / iPad: iOS 16.4 ขึ้นไป ต้อง "แชร์ → เพิ่มไปยังหน้าจอโฮม" แล้วเปิดจากไอคอนก่อน
- ปิดโหมดประหยัดแบตเตอรี่สำหรับเบราว์เซอร์ ไม่อย่างนั้นการแจ้งเตือนอาจมาช้า
- Web Push ไม่รับประกันการส่งถึง 100% (ขึ้นกับ Google / Apple และสัญญาณมือถือ) งานวิกฤตจึงต้องมีไซเรน / ไฟเตือนที่หน้าฟาร์มจาก PLC ด้วย (เฟส Edge agent)

VAPID key สร้างเองครั้งแรกแล้วเก็บในฐานข้อมูล ถ้าจะกำหนดเอง (เช่น ย้ายเครื่อง) ตั้ง `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` ใน `.env`

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
- [x] Ingest + simulator + หน้าภาพรวม + หน้ารายละเอียดบ่อ (realtime ผ่าน SSE)
- [x] โครงสร้าง Unit/RAS: การ์ด Unit แสดงค่า RAS, หน้ารายละเอียด RAS, หัววัด DO ในบ่อ
- [x] บันทึกหน้างานแบบ offline-first: ให้อาหาร, สุ่มน้ำหนัก, ค่าน้ำชุดทดสอบ (RAS), ผล Lab, รอบการเลี้ยง
- [x] Alert engine: เกณฑ์ + เวลายืนยัน, Web Push + เสียงในแอป, รับทราบ + ส่งซ้ำ/ส่งต่อ (ไม่ใช้ LINE / SMS)
- [ ] สั่งงานอุปกรณ์: cmd → ack → state, หมดอายุคำสั่ง, Local/Remote, audit log
- [ ] Edge agent บน IPC: Modbus/OPC UA → MQTT, buffer, siren (รอข้อมูลรุ่น PLC)
