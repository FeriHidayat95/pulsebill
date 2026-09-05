# Network Automation and RADIUS Architecture

This document describes PulseBill integration with Mikrotik RouterOS hardware and FreeRADIUS servers.

---

## Architecture Overview

PulseBill operates as the central control plane between customer financial states and network access enforcement:

```
[ Customer Portal / Invoicing ]
              |
              v
     [ PulseBill Engine ]
       /              \
      v                v
[ FreeRADIUS AAA ]   [ Mikrotik RouterOS API (Port 8728) ]
      |                        |
[ radcheck / radacct ]    [ PPPoE Server / Dynamic Queues ]
```

---

## RouterOS Binary API Integration

### Connection Pool Configuration
- **Port:** `8728` (cleartext) or `8729` (TLS encrypted)
- **Protocol:** Duplex binary word packets (`/ppp/secret/set =name=...`)
- **Connection Management:** Persistent pooled sockets with heartbeat keep-alive every 30 seconds.

### Profile Isolation Workflow
When a customer fails to settle an invoice past the grace period:
1. Engine initiates an atomic transaction in `customers` table setting status to `suspended`.
2. Dynamic policy updates `radusergroup` to map the username to `pool-pulsebill-isolir`.
3. RouterOS API executes `/ppp/active/remove` terminating the subscriber's current session.
4. When the subscriber's router reconnects via PPPoE, RADIUS issues an isolated IP address (`10.10.10.x`) with DNS firewall redirection to the captive payment portal.

---

## FreeRADIUS AAA Schema Integration

PulseBill connects directly to the standard FreeRADIUS relational tables:

| Table | Purpose | Managed Fields |
| :--- | :--- | :--- |
| `radcheck` | User authentication & password verification | `username`, `attribute` (`Cleartext-Password`, `Expiration`) |
| `radreply` | Per-subscriber session parameters | `Framed-IP-Address`, `Mikrotik-Rate-Limit` |
| `radusergroup` | Group profile mapping | `username`, `groupname` (`50M_Fiber`, `pool-pulsebill-isolir`) |
| `radacct` | Accounting telemetry & byte counters | `acctstarttime`, `acctstoptime`, `acctinputoctets`, `acctoutputoctets` |
