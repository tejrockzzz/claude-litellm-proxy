import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { config } from './config'
import { logger as appLogger } from './logger'
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  validateAnthropicRequest,
} from './converter'
import type { AnthropicRequest, OpenAIResponse } from './types'

type Variables = {
  requestId: string
}

const app = new Hono<{ Variables: Variables }>()

// Middleware
app.use('*', secureHeaders())
app.use('*', cors())
app.use('*', logger())

// Request ID middleware
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)
  c.header('X-Request-ID', requestId)
  await next()
})

// Error handler
app.onError((err, c) => {
  const requestId = c.get('requestId')
  appLogger.error({ err, requestId }, 'Request failed')

  return c.json(
    {
      error: {
        type: 'internal_error',
        message: config.nodeEnv === 'production' ? 'Internal server error' : err.message,
      },
    },
    500
  )
})

/**
 * Handle non-streaming request
 */
async function handleNonStreamingRequest(
  c: any,
  requestId: string,
  anthropicRequest: AnthropicRequest,
  openaiRequest: any,
  startTime: number
) {
  // Forward to LiteLLM
  const response = await fetch(`${config.litellmBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.upstreamApiKey}`,
      'X-Request-ID': requestId,
    },
    body: JSON.stringify(openaiRequest),
    signal: AbortSignal.timeout(120000), // 2 minute timeout
  })

  if (!response.ok) {
    const errorText = await response.text()
    appLogger.error(
      {
        requestId,
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      },
      'Upstream request failed'
    )

    return c.json(
      {
        error: {
          type: 'upstream_error',
          message: `LiteLLM request failed: ${response.status} ${response.statusText}`,
        },
      },
      response.status as any
    )
  }

  const openaiResponse = (await response.json()) as OpenAIResponse

  // Convert back to Anthropic format
  const anthropicResponse = openAIToAnthropic(openaiResponse, anthropicRequest.model)

  const duration = Date.now() - startTime

  appLogger.info(
    {
      requestId,
      duration,
      inputTokens: anthropicResponse.usage.input_tokens,
      outputTokens: anthropicResponse.usage.output_tokens,
      stopReason: anthropicResponse.stop_reason,
    },
    'Request completed'
  )

  return c.json(anthropicResponse)
}

/**
 * Handle streaming request
 */
async function handleStreamingRequest(
  c: any,
  requestId: string,
  anthropicRequest: AnthropicRequest,
  openaiRequest: any,
  startTime: number
) {
  // Forward to LiteLLM with streaming
  const response = await fetch(`${config.litellmBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.upstreamApiKey}`,
      'X-Request-ID': requestId,
    },
    body: JSON.stringify(openaiRequest),
    signal: AbortSignal.timeout(120000),
  })

  if (!response.ok) {
    const errorText = await response.text()
    appLogger.error(
      {
        requestId,
        status: response.status,
        error: errorText,
      },
      'Upstream streaming request failed'
    )

    return c.json(
      {
        error: {
          type: 'upstream_error',
          message: `LiteLLM request failed: ${response.status}`,
        },
      },
      response.status as any
    )
  }

  // Set up streaming response
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
        let inputTokens = 0
        let outputTokens = 0
        let contentBlockIndex = 0
        let textBlockStarted = false
        let toolCalls: any[] = []

        // Send message_start event
        const messageStart = {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: anthropicRequest.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
            },
          },
        }
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`))

        // Send initial content_block_start for text
        const textBlockStart = {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }
        controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(textBlockStart)}\n\n`))
        textBlockStarted = true

        // Send ping
        controller.enqueue(encoder.encode(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`))

        // Process the stream
        const reader = response.body?.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        if (!reader) {
          throw new Error('No response body')
        }

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.trim() || line.startsWith(':')) continue

            if (line.startsWith('data: ')) {
              const data = line.slice(6)
              if (data === '[DONE]') continue

              try {
                const chunk = JSON.parse(data)

                // Update usage if available
                if (chunk.usage) {
                  inputTokens = chunk.usage.prompt_tokens || inputTokens
                  outputTokens = chunk.usage.completion_tokens || outputTokens
                }

                const choice = chunk.choices?.[0]
                if (!choice) continue

                const delta = choice.delta

                // Handle text content
                if (delta?.content) {
                  const textDelta = {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: delta.content },
                  }
                  controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(textDelta)}\n\n`))
                }

                // Handle tool calls
                if (delta?.tool_calls) {
                  // Close text block if it was open
                  if (textBlockStarted) {
                    const textBlockStop = { type: 'content_block_stop', index: 0 }
                    controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(textBlockStop)}\n\n`))
                    textBlockStarted = false
                  }

                  for (const toolCall of delta.tool_calls) {
                    const toolIndex = toolCall.index || 0

                    // Check if this is a new tool call
                    if (!toolCalls[toolIndex]) {
                      toolCalls[toolIndex] = {
                        id: toolCall.id || `toolu_${Date.now()}_${toolIndex}`,
                        name: toolCall.function?.name || '',
                        arguments: '',
                      }

                      // Send tool_use block start
                      contentBlockIndex++
                      const toolBlockStart = {
                        type: 'content_block_start',
                        index: contentBlockIndex,
                        content_block: {
                          type: 'tool_use',
                          id: toolCalls[toolIndex].id,
                          name: toolCalls[toolIndex].name,
                          input: {},
                        },
                      }
                      controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(toolBlockStart)}\n\n`))
                    }

                    // Accumulate arguments
                    if (toolCall.function?.arguments) {
                      toolCalls[toolIndex].arguments += toolCall.function.arguments

                      // Send input delta
                      const inputDelta = {
                        type: 'content_block_delta',
                        index: contentBlockIndex,
                        delta: {
                          type: 'input_json_delta',
                          partial_json: toolCall.function.arguments,
                        },
                      }
                      controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(inputDelta)}\n\n`))
                    }
                  }
                }

                // Handle finish_reason
                if (choice.finish_reason) {
                  // Close any open blocks
                  if (textBlockStarted) {
                    const textBlockStop = { type: 'content_block_stop', index: 0 }
                    controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(textBlockStop)}\n\n`))
                  }

                  // Close tool blocks
                  for (let i = 1; i <= toolCalls.length; i++) {
                    const toolBlockStop = { type: 'content_block_stop', index: i }
                    controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(toolBlockStop)}\n\n`))
                  }

                  // Map stop reason
                  let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' = 'end_turn'
                  if (choice.finish_reason === 'length') stopReason = 'max_tokens'
                  else if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use'

                  // Send message_delta
                  const messageDelta = {
                    type: 'message_delta',
                    delta: { stop_reason: stopReason, stop_sequence: null },
                    usage: { output_tokens: outputTokens },
                  }
                  controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`))

                  // Send message_stop
                  controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`))

                  const duration = Date.now() - startTime
                  appLogger.info(
                    {
                      requestId,
                      duration,
                      inputTokens,
                      outputTokens,
                      stopReason,
                    },
                    'Streaming request completed'
                  )

                  controller.close()
                  return
                }
              } catch (err) {
                appLogger.error({ requestId, error: err }, 'Error parsing SSE chunk')
              }
            }
          }
        }

        // If we get here without a finish_reason, close gracefully
        if (textBlockStarted) {
          const textBlockStop = { type: 'content_block_stop', index: 0 }
          controller.enqueue(`event: content_block_stop\ndata: ${JSON.stringify(textBlockStop)}\n\n`)
        }

        const messageDelta = {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }
        controller.enqueue(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`)
        controller.enqueue(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)

        controller.close()
      } catch (error) {
        appLogger.error({ requestId, error }, 'Streaming error')
        controller.error(error)
      }
    },
  })

  return c.body(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

/**
 * Health check endpoint
 */
app.get('/health', async (c) => {
  try {
    // Verify LiteLLM connectivity
    const response = await fetch(`${config.litellmBaseUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    })

    const healthy = response.ok

    return c.json(
      {
        status: healthy ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        litellm: {
          status: healthy ? 'connected' : 'disconnected',
          url: config.litellmBaseUrl,
        },
      },
      healthy ? 200 : 503
    )
  } catch (error) {
    appLogger.error({ error }, 'Health check failed')
    return c.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        litellm: {
          status: 'error',
          url: config.litellmBaseUrl,
        },
      },
      503
    )
  }
})

/**
 * Root endpoint - service information
 */
app.get('/', (c) => {
  return c.json({
    service: 'Claude Code LiteLLM Proxy',
    version: '1.0.0',
    model: config.model,
    endpoints: {
      health: '/health',
      messages: '/v1/messages',
      count_tokens: '/v1/messages/count_tokens',
    },
  })
})

/**
 * Main messages endpoint - handles chat completions
 */
app.post('/v1/messages', async (c) => {
  const requestId = c.get('requestId')
  const startTime = Date.now()

  try {
    const anthropicRequest = await c.req.json<AnthropicRequest>()

    // Validate request
    validateAnthropicRequest(anthropicRequest)

    appLogger.info(
      {
        requestId,
        originalModel: anthropicRequest.model,
        targetModel: config.model,
        messageCount: anthropicRequest.messages.length,
        maxTokens: anthropicRequest.max_tokens,
        stream: anthropicRequest.stream,
      },
      'Processing request'
    )

    // Convert to OpenAI format
    const openaiRequest = anthropicToOpenAI(anthropicRequest, config.model)

    // Handle streaming vs non-streaming
    if (anthropicRequest.stream) {
      return handleStreamingRequest(c, requestId, anthropicRequest, openaiRequest, startTime)
    } else {
      return handleNonStreamingRequest(c, requestId, anthropicRequest, openaiRequest, startTime)
    }
  } catch (error) {
    const duration = Date.now() - startTime

    if (error instanceof Error) {
      appLogger.error(
        {
          requestId,
          duration,
          error: error.message,
          stack: error.stack,
        },
        'Request failed'
      )

      // Handle validation errors
      if (error.message.includes('Invalid request')) {
        return c.json(
          {
            error: {
              type: 'invalid_request_error',
              message: error.message,
            },
          },
          400
        )
      }

      // Handle timeout
      if (error.name === 'AbortError') {
        return c.json(
          {
            error: {
              type: 'timeout_error',
              message: 'Request to LiteLLM timed out',
            },
          },
          504
        )
      }
    }

    throw error
  }
})

/**
 * Token counting endpoint
 */
app.post('/v1/messages/count_tokens', async (c) => {
  const requestId = c.get('requestId')

  try {
    const request = await c.req.json<AnthropicRequest>()

    // Validate basic structure
    if (!request.messages || !Array.isArray(request.messages)) {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: 'Invalid request: messages must be an array',
          },
        },
        400
      )
    }

    // Simple estimation: ~4 characters per token
    const messagesText = JSON.stringify(request.messages)
    const systemText = request.system ? JSON.stringify(request.system) : ''
    const totalChars = messagesText.length + systemText.length

    const estimatedTokens = Math.ceil(totalChars / 4)

    appLogger.debug(
      {
        requestId,
        messageCount: request.messages.length,
        estimatedTokens,
      },
      'Token count estimated'
    )

    return c.json({
      input_tokens: estimatedTokens,
    })
  } catch (error) {
    appLogger.error({ requestId, error }, 'Token counting failed')

    return c.json(
      {
        error: {
          type: 'internal_error',
          message: 'Failed to count tokens',
        },
      },
      500
    )
  }
})

// Graceful shutdown
const shutdown = () => {
  appLogger.info('Received shutdown signal, closing server...')
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Start server
const server = serve({
  fetch: app.fetch,
  port: config.port,
})

appLogger.info(
  {
    port: config.port,
    model: config.model,
    litellmUrl: config.litellmBaseUrl,
    nodeEnv: config.nodeEnv,
  },
  'Server started successfully'
)
