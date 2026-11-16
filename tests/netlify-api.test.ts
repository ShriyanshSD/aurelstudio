import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handler } from '../netlify/functions/api'
import { validateChatRequest } from '../security-config'
import { sanitizeInput, validateCheckoutForm } from '../src/utils/security'

interface NetlifyFunctionResponse {
  statusCode: number
  headers?: Record<string, string>
  body?: string
}

const isNetlifyFunctionResponse = (value: Object): value is NetlifyFunctionResponse =>
  'statusCode' in value
  && typeof value.statusCode === 'number'
  && 'body' in value

test('routes Netlify API rewrites through the shared API handler', async () => {
  const envNames = ['AUREL_UPI_ID', 'AUREL_UPI_PAYEE_NAME', 'AUREL_WHATSAPP_NUMBER'] as const
  const originalEnv = envNames.map(name => process.env[name])
  const invokePaymentConfig = () => handler({
    httpMethod: 'GET',
    path: '/.netlify/functions/api/payment/config',
    headers: { host: 'aurel.netlify.app' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
  }, {})

  try {
    process.env.AUREL_UPI_ID = 'store@test'
    process.env.AUREL_UPI_PAYEE_NAME = 'AUREL Test'
    process.env.AUREL_WHATSAPP_NUMBER = '8581234567'

    const response = await invokePaymentConfig()
    assert.ok(isNetlifyFunctionResponse(response))
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers?.['x-frame-options'], 'DENY')
    assert.equal(JSON.parse(response.body ?? '').config.whatsappNumber, '918581234567')

    delete process.env.AUREL_WHATSAPP_NUMBER
    const unconfiguredResponse = await invokePaymentConfig()
    assert.ok(isNetlifyFunctionResponse(unconfiguredResponse))
    assert.equal(unconfiguredResponse.statusCode, 503)
  } finally {
    envNames.forEach((name, index) => {
      const originalValue = originalEnv[index]
      if (originalValue === undefined) delete process.env[name]
      else process.env[name] = originalValue
    })
  }
})

test('rejects oversized or unapproved chat payloads', () => {
  const oversized = {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'a'.repeat(4001) }]
  }

  const invalid = {
    model: 'custom-model',
    messages: [{ role: 'user', content: 'Hello there' }]
  }

  const oversizedResult = validateChatRequest(oversized)
  assert.equal(oversizedResult.ok, false)
  if (oversizedResult.ok === false) assert.equal(oversizedResult.status, 400)

  const invalidResult = validateChatRequest(invalid)
  assert.equal(invalidResult.ok, false)
  if (invalidResult.ok === false) assert.equal(invalidResult.status, 400)

  const validResult = validateChatRequest({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'Where is my order?' }]
  })
  assert.equal(validResult.ok, true)
  if (validResult.ok) {
    assert.equal(validResult.model, 'gemini-2.5-flash')
    assert.equal(validResult.messages.length, 1)
  }
})

test('sanitizes form inputs before checkout submission', () => {
  const dirty = '<script>alert(1)</script>javascript:alert(1) onerror=alert(1) Aurel & Co'
  const sanitized = sanitizeInput(dirty)
  assert.equal(sanitized.includes('<script'), false)
  assert.equal(sanitized.includes('javascript'), false)
  assert.equal(sanitized.includes('onerror'), false)
  assert.equal(sanitized.includes('Aurel'), true)

  const valid = validateCheckoutForm({
    customerName: 'Aurel Customer',
    phoneNumber: '+91 9876543210',
    email: 'user@example.com',
    address: 'Main Street 12, Bengaluru',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560001',
    notes: '<b>VIP order</b>'
  })
  assert.equal(valid.isValid, true)
  assert.equal(valid.sanitizedData.notes, 'VIP order')
})
