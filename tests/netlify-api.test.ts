import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handler } from '../netlify/functions/api'

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
  const response = await handler({
    httpMethod: 'GET',
    path: '/.netlify/functions/api/payment/config',
    headers: { host: 'aurel.netlify.app' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
  }, {})

  assert.ok(isNetlifyFunctionResponse(response))
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers?.['x-frame-options'], 'DENY')
  assert.equal(JSON.parse(response.body ?? '').config.payeeName, 'AUREL')
})
