# EMQX hardening before production

The compose file starts EMQX with defaults, which **allow anonymous clients**. Do these before
connecting a real farm. The dashboard is bound to 127.0.0.1:18083; reach it over SSH:
`ssh -L 18083:127.0.0.1:18083 user@vps` then open http://localhost:18083.

## 1. Authentication

Dashboard → Access Control → Authentication → create "Password-Based / Built-in Database".
Create one user per farm gateway (e.g. `gw-F1`) plus one service user for api/ingest
(`MQTT_SERVICE_USER` / `MQTT_SERVICE_PASSWORD` in `.env`).

## 2. Authorization (ACL)

Access Control → Authorization → File / Built-in Database, then set "no match" to **deny**:

| User | Allow | Topics |
|---|---|---|
| `gw-F1` | publish | `sff/F1/+/telemetry`, `sff/F1/+/state`, `sff/F1/+/cmd/ack`, `sff/F1/gateway/status`, `sff/F1/alarm` |
| `gw-F1` | subscribe | `sff/F1/+/cmd` |
| service user | subscribe | `sff/#` |
| service user | publish | `sff/+/+/cmd` |

A gateway can then only write its own farm's data and only receive its own commands.

## 3. TLS only

Put the certificate on the `ssl:default` listener (8883), e.g. by mounting files and setting
`EMQX_LISTENERS__SSL__DEFAULT__SSL_OPTIONS__CERTFILE` / `KEYFILE`. Then in `.env` set
`MQTT_PUBLIC_PORT` to a port the firewall blocks (or remove the 1883 mapping) so only 8883
is reachable from the internet. Gateways connect outbound only; never open ports at the farm.

## 4. License note

`emqx/emqx:5.8.x` is Apache-2.0. From 5.9 EMQX uses the Business Source License (free for a
single node). Re-check the terms before upgrading or clustering.
