# PulseBill REST API & Webhook Reference

This document provides technical specifications for the PulseBill Telecom Billing and Provisioning REST API.

---

## Authentication and Security

PulseBill endpoints require standard session authentication or Bearer API keys depending on the endpoint scope.

### Header Specification
```http
Authorization: Bearer <api_token>
Content-Type: application/json
Accept: application/json
```

---

## Health and Telemetry

### `GET /health`
Returns system liveness, database connection status, and cache availability.

- **Response (200 OK):**
  ```json
  {
    "status": "healthy",
    "uptime_seconds": 86400,
    "timestamp": "2026-09-05T20:50:00Z",
    "database": {
      "driver": "mysql",
      "connected": true
    },
    "redis": {
      "connected": true
    }
  }
  ```

---

## Invoices and Billing Engine

### `GET /api/invoices`
Retrieves a paginated list of subscriber invoices.

- **Query Parameters:**
  - `status` *(optional)*: `paid` | `unpaid` | `pending`
  - `month` *(optional)*: Integer (`1` to `12`)
  - `year` *(optional)*: Integer (e.g. `2026`)
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": [
      {
        "id": 104,
        "invoice_number": "INV-2026-09-001",
        "customer_id": 42,
        "customer_name": "Elena Rostova",
        "amount": 199.99,
        "due_date": "2026-09-15",
        "status": "unpaid",
        "package_name": "Fiber Enterprise 500M"
      }
    ]
  }
  ```

### `POST /api/invoices/generate`
Triggers automated batch invoice generation for all active subscribers matching current billing cycle.

- **Request Body:**
  ```json
  {
    "billing_cycle_day": 1,
    "force_reissue": false
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "generated_count": 1420,
    "total_amount": 78100.00
  }
  ```

---

## Payment Gateway Webhooks

### `POST /api/webhooks/stripe`
Ingests signed Stripe payment events and verifies HMAC SHA-256 signatures.

- **Headers Required:**
  - `Stripe-Signature`: `t=1725540000,v1=5257a869e7eee...`
- **Response (200 OK):**
  ```json
  {
    "received": true,
    "invoice_number": "INV-2026-09-001",
    "status": "settled"
  }
  ```

### `POST /api/webhooks/midtrans`
Handles payment settlement notifications from Midtrans and validates SHA-512 signature hashes.

### `POST /api/webhooks/xendit`
Ingests callback tokens from Xendit and settles customer invoices with exactly-once idempotency.

---

## Network and RouterOS Automation

### `POST /api/network/routeros/sync`
Synchronizes subscriber PPPoE rate limits with current account balance and status.

- **Request Body:**
  ```json
  {
    "username": "elena_rostova",
    "action": "reconcile"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "username": "elena_rostova",
    "applied_profile": "500M_Symmetric",
    "session_state": "active",
    "latency_ms": 12
  }
  ```
