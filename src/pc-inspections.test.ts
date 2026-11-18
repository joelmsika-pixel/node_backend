import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePcInspectionDevices, pcHealthCondition } from './pc-inspections.js'

function blankDevice(index: number): Record<string, unknown> {
  return {
    device_name: `PC ${index + 1}`,
    computer_received_type: '',
    charger_type: '',
    charger_functionality: '',
    charger_brand: '',
    total_chargers_received: null,
    laptop_model: '',
    laptop_id: '',
    pre_sound: '',
    pre_condition: '',
    storage: '',
    keyboard: '',
    disk_health: null,
    battery_health: null,
    post_sound: '',
    reported_issue: '',
  }
}

test('accepts a 100-PC report batch', () => {
  const result = parsePcInspectionDevices(Array.from({ length: 100 }, (_, index) => blankDevice(index)))

  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.devices.length, 100)
})

test('rejects invalid checkup ratings and missing device names', () => {
  const invalidHealth = blankDevice(0)
  invalidHealth.disk_health = 101
  const result = parsePcInspectionDevices([invalidHealth])
  const invalidName = blankDevice(0)
  invalidName.device_name = ' '

  assert.deepEqual(result, { ok: false, error: 'PC 1: disk health is invalid.' })
  assert.deepEqual(parsePcInspectionDevices([invalidName]), {
    ok: false,
    error: 'PC 1: device name is invalid.',
  })
})

test('maps disk and battery health percentages to the requested bands', () => {
  assert.equal(pcHealthCondition(0), 'normal')
  assert.equal(pcHealthCondition(60), 'normal')
  assert.equal(pcHealthCondition(61), 'good')
  assert.equal(pcHealthCondition(70), 'good')
  assert.equal(pcHealthCondition(71), 'excellent')
  assert.equal(pcHealthCondition(80), 'excellent')
  assert.equal(pcHealthCondition(81), 'super')
  assert.equal(pcHealthCondition(100), 'super')
  assert.equal(pcHealthCondition(null), '')
})
