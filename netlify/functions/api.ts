import express from 'express'
import serverless from 'serverless-http'
import apiHandler from '../../api/index.js'
import { getSecurityHeaders } from '../../security-headers.js'

const app = express()

app.use((_req, res, next) => {
  for (const [name, value] of Object.entries(getSecurityHeaders(true))) {
    res.setHeader(name, value)
  }
  next()
})
app.use('/api/admin/products/upload', express.json({ limit: '4mb' }))
app.use(express.json())
app.use((req, res) => {
  const requestUrl = new URL(req.url ?? '/', 'http://localhost')
  const functionPrefix = '/.netlify/functions/api'
  if (requestUrl.pathname.startsWith(`${functionPrefix}/`)) {
    requestUrl.pathname = `/api/${requestUrl.pathname.slice(functionPrefix.length + 1)}`
    req.url = `${requestUrl.pathname}${requestUrl.search}`
  }
  return apiHandler(req, res)
})

export const handler = serverless(app)
