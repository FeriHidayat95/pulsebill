const test = require('node:test');
const assert = require('node:assert/strict');

function calculateBandwidthLimit(packageSpeed) {
    if (!packageSpeed) return '10M/10M';
    const match = packageSpeed.match(/^(\d+)\s*(M|k|G)?/i);
    if (!match) return '10M/10M';
    
    const val = parseInt(match[1], 10);
    const unit = (match[2] || 'M').toUpperCase();
    
    // Symmetric tier calculation
    return `${val}${unit}/${val}${unit}`;
}

function buildRouterOSProfileArgs(name, rateLimit, poolName) {
    return [
        `=name=${name}`,
        `=rate-limit=${rateLimit}`,
        `=local-address=192.168.88.1`,
        `=remote-address=${poolName || 'pool-pulsebill'}`
    ];
}

test('Bandwidth Limit: parse speed strings into RouterOS rate-limit format', () => {
    assert.equal(calculateBandwidthLimit('50 Mbps'), '50M/50M');
    assert.equal(calculateBandwidthLimit('100M'), '100M/100M');
    assert.equal(calculateBandwidthLimit('20 Mbps Fiber'), '20M/20M');
    assert.equal(calculateBandwidthLimit(''), '10M/10M');
});

test('RouterOS Command Builder: format binary API argument vector', () => {
    const args = buildRouterOSProfileArgs('plan-enterprise-50m', '50M/50M', 'pool-subscribers');
    assert.deepEqual(args, [
        '=name=plan-enterprise-50m',
        '=rate-limit=50M/50M',
        '=local-address=192.168.88.1',
        '=remote-address=pool-subscribers'
    ]);
});
