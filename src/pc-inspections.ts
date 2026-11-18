export type PcInspectionDevice = {
  device_name: string
  computer_received_type: string
  charger_type: string
  charger_functionality: '' | 'working' | 'not_working' | 'not_received'
  charger_brand: string
  total_chargers_received: number | null
  laptop_model: string
  laptop_id: string
  pre_sound: '' | 'working' | 'not_working'
  pre_condition: '' | 'good' | 'excellent' | 'normal' | 'poor'
  storage: string
  keyboard: '' | 'working' | 'not_working'
  disk_health: number | null
  battery_health: number | null
  post_sound: '' | 'working' | 'not_working'
  reported_issue: string
}

export type PcInspectionParseResult =
  | { ok: true; devices: PcInspectionDevice[] }
  | { ok: false; error: string }

const statusValues = ['working', 'not_working'] as const
const chargerValues = ['working', 'not_working', 'not_received'] as const
const conditionValues = ['good', 'excellent', 'normal', 'poor'] as const

function readText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length <= maxLength ? normalized : null
}

function readEnum<T extends string>(value: unknown, values: readonly T[]): T | '' | null {
  const normalized = readText(value, 40)
  if (normalized === null) return null
  if (!normalized) return ''
  return values.includes(normalized as T) ? normalized as T : null
}

function readInteger(value: unknown, min: number, max: number): number | null | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < min || number > max) return undefined
  return number
}

function invalidDevice(index: number, field: string): PcInspectionParseResult {
  return { ok: false, error: `PC ${index + 1}: ${field} is invalid.` }
}

export function parsePcInspectionDevices(input: unknown): PcInspectionParseResult {
  if (!Array.isArray(input) || input.length === 0 || input.length > 1000) {
    return { ok: false, error: 'Add between 1 and 1000 PCs to the report.' }
  }

  const devices: PcInspectionDevice[] = []
  for (const [index, raw] of input.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return invalidDevice(index, 'device details')
    }

    const item = raw as Record<string, unknown>
    const deviceName = readText(item.device_name, 150)
    const computerReceivedType = readText(item.computer_received_type, 100)
    const chargerType = readText(item.charger_type, 100)
    const chargerFunctionality = readEnum(item.charger_functionality, chargerValues)
    const chargerBrand = readText(item.charger_brand, 100)
    const totalChargersReceived = readInteger(item.total_chargers_received, 0, 10000)
    const laptopModel = readText(item.laptop_model, 150)
    const laptopId = readText(item.laptop_id, 100)
    const preSound = readEnum(item.pre_sound, statusValues)
    const preCondition = readEnum(item.pre_condition, conditionValues)
    const storage = readText(item.storage, 100)
    const keyboard = readEnum(item.keyboard, statusValues)
    const diskHealth = readInteger(item.disk_health, 0, 100)
    const batteryHealth = readInteger(item.battery_health, 0, 100)
    const postSound = readEnum(item.post_sound, statusValues)
    const reportedIssue = readText(item.reported_issue, 2000)

    if (deviceName === null || !deviceName) return invalidDevice(index, 'device name')
    if (computerReceivedType === null) return invalidDevice(index, 'computer received type')
    if (chargerType === null) return invalidDevice(index, 'charger type')
    if (chargerFunctionality === null) return invalidDevice(index, 'charger functionality')
    if (chargerBrand === null) return invalidDevice(index, 'charger brand')
    if (totalChargersReceived === undefined) return invalidDevice(index, 'total chargers received')
    if (laptopModel === null) return invalidDevice(index, 'laptop model')
    if (laptopId === null) return invalidDevice(index, 'laptop ID')
    if (preSound === null) return invalidDevice(index, 'pre-checkup sound')
    if (preCondition === null) return invalidDevice(index, 'condition')
    if (storage === null) return invalidDevice(index, 'storage')
    if (keyboard === null) return invalidDevice(index, 'keyboard')
    if (diskHealth === undefined) return invalidDevice(index, 'disk health')
    if (batteryHealth === undefined) return invalidDevice(index, 'battery health')
    if (postSound === null) return invalidDevice(index, 'post-checkup sound')
    if (reportedIssue === null) return invalidDevice(index, 'reported issue')

    devices.push({
      device_name: deviceName,
      computer_received_type: computerReceivedType,
      charger_type: chargerType,
      charger_functionality: chargerFunctionality,
      charger_brand: chargerBrand,
      total_chargers_received: totalChargersReceived,
      laptop_model: laptopModel,
      laptop_id: laptopId,
      pre_sound: preSound,
      pre_condition: preCondition,
      storage,
      keyboard,
      disk_health: diskHealth,
      battery_health: batteryHealth,
      post_sound: postSound,
      reported_issue: reportedIssue,
    })
  }

  return { ok: true, devices }
}

export function pcHealthCondition(value: number | null): '' | 'normal' | 'good' | 'excellent' | 'super' {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 100) return ''
  if (value <= 60) return 'normal'
  if (value <= 70) return 'good'
  if (value <= 80) return 'excellent'
  return 'super'
}
