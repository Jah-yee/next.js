import type { ServerResponse, IncomingMessage } from 'http'
import {
  getOrCreateMcpServer,
  type McpServerOptions,
} from './get-or-create-mcp-server'
import { parseBody } from '../api-utils/node/parse-body'
import { StreamableHTTPServerTransport } from 'next/dist/compiled/@modelcontextprotocol/sdk/server/streamableHttp'
import { subscribe, type HmrBuildResult } from '../dev/hmr-cycle-emitter'

export function getMcpMiddleware(options: McpServerOptions) {
  return async function (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ): Promise<void> {
    const { pathname } = new URL(req.url || '', 'http://n')

    // SSE events endpoint — subscribe to HMR cycle events
    if (pathname === '/_next/mcp/events' && req.method === 'GET') {
      return handleEventsSSE(res)
    }

    if (!pathname.startsWith('/_next/mcp')) {
      return next()
    }
    const mcpServer = getOrCreateMcpServer(options)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    try {
      res.on('close', () => {
        transport.close()
      })
      await mcpServer.connect(transport)
      const parsedBody = await parseBody(req, 1024 * 1024) // 1MB limit
      await transport.handleRequest(req, res, parsedBody)
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Internal server error' },
            id: null,
          })
        )
      }
    }
  }
}

function handleEventsSSE(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })

  // Send initial connected event
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)

  const unsubscribe = subscribe((result: HmrBuildResult) => {
    const event = {
      type: 'hmr',
      compilation: {
        status: result.errors.length > 0 ? 'compile_error' : 'ok',
        version: result.hash,
        duration_ms: result.durationMs,
        errors: result.errors,
        warnings: result.warnings,
        updated_modules: result.updatedModules,
      },
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  })

  res.on('close', () => {
    unsubscribe()
  })
}
