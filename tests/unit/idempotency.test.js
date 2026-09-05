const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

test('Webhook Idempotency: generate deterministic idempotency key', () => {
    const payload = JSON.stringify({
        event: 'charge.completed',
        invoice_id: 'INV-2026-09-001',
        amount: 350000,
        timestamp: 1725540000
    });
    
    const secret = 'webhook_secret_key_123';
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const signature2 = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    
    assert.equal(signature, signature2, 'HMAC signature must be deterministic');
    assert.equal(signature.length, 64, 'HMAC SHA-256 must produce 64 hex characters');
});

test('Webhook Signature Verification: reject forged signature', () => {
    const payload = JSON.stringify({ invoice_id: 'INV-2026-09-001', amount: 350000 });
    const validSignature = crypto.createHmac('sha256', 'real_secret').update(payload).digest('hex');
    const forgedSignature = crypto.createHmac('sha256', 'attacker_secret').update(payload).digest('hex');
    
    assert.notEqual(validSignature, forgedSignature, 'Forged signature with invalid secret must not match');
});

test('Idempotency Replay Guard: simulate cache deduplication', () => {
    const processedEvents = new Set();
    
    function processWebhook(eventId) {
        if (processedEvents.has(eventId)) {
            return { status: 'duplicate_ignored', processed: false };
        }
        processedEvents.add(eventId);
        return { status: 'processed', processed: true };
    }
    
    const event1 = processWebhook('evt_stripe_12345');
    assert.equal(event1.processed, true);
    
    // Simulate replay attack / retried HTTP POST
    const event2 = processWebhook('evt_stripe_12345');
    assert.equal(event2.processed, false);
    assert.equal(event2.status, 'duplicate_ignored');
});
