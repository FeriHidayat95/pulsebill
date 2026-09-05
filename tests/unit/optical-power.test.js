const test = require('node:test');
const assert = require('node:assert/strict');

function classifyRxPower(dBm) {
    const power = parseFloat(dBm);
    if (isNaN(power)) return 'UNKNOWN';
    if (power < -27.0) return 'CRITICAL_LOS';
    if (power < -24.0) return 'DEGRADED_WARNING';
    if (power >= -24.0 && power <= -8.0) return 'OPTIMAL';
    return 'SATURATED_OVERLOAD';
}

test('TR-069 Optical Power: classify optical signal quality', () => {
    assert.equal(classifyRxPower('-18.45'), 'OPTIMAL');
    assert.equal(classifyRxPower('-21.20'), 'OPTIMAL');
    assert.equal(classifyRxPower('-25.60'), 'DEGRADED_WARNING');
    assert.equal(classifyRxPower('-28.10'), 'CRITICAL_LOS');
    assert.equal(classifyRxPower('-6.50'), 'SATURATED_OVERLOAD');
    assert.equal(classifyRxPower('N/A'), 'UNKNOWN');
});
