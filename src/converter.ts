import {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicContentBlock,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIMessage,
  OpenAITool,
} from './types'
import { logger } from './logger'

/**
 * Convert Anthropic request format to OpenAI format
 */
export function anthropicToOpenAI(
  anthropic: AnthropicRequest,
  targetModel: string
): OpenAIRequest {
  const messages: OpenAIMessage[] = []

  // Handle system message
  if (anthropic.system) {
    const systemContent =
      typeof anthropic.system === 'string'
        ? anthropic.system
        : anthropic.system
            .map((block) => (block.type === 'text' ? block.text : ''))
            .filter(Boolean)
            .join('\n')

    if (systemContent) {
      messages.push({
        role: 'system',
        content: systemContent,
      })
    }
  }

  // Convert messages
  for (const message of anthropic.messages) {
    if (typeof message.content === 'string') {
      // Simple text message
      messages.push({
        role: message.role as 'user' | 'assistant',
        content: message.content,
      })
    } else {
      // Complex content with blocks (text, images, tools)
      const hasImages = message.content.some((block: AnthropicContentBlock) => block.type === 'image')
      
      if (hasImages) {
        // Use OpenAI's array format for messages with images
        const contentArray: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
        
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            contentArray.push({ type: 'text', text: block.text })
          } else if (block.type === 'image') {
            // Handle both source types: base64 and url
            if (block.source?.type === 'base64') {
              const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`
              contentArray.push({ type: 'image_url', image_url: { url: dataUrl } })
            } else if (block.source?.type === 'url') {
              contentArray.push({ type: 'image_url', image_url: { url: block.source.url } })
            }
          }
        }
        
        messages.push({
          role: message.role as 'user' | 'assistant',
          content: contentArray,
        })
      } else {
        // No images, flatten to text
        const textContent = message.content
          .map((block: AnthropicContentBlock) => {
            if (block.type === 'text') return block.text || ''
            if (block.type === 'tool_result') {
              return `[Tool Result: ${block.tool_use_id || 'unknown'}]\n${
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content)
              }`
            }
            if (block.type === 'tool_use') {
              return `[Tool Use: ${block.name || 'unknown'}]\n${JSON.stringify(
                block.input || {}
              )}`
            }
            return ''
          })
          .filter(Boolean)
          .join('\n')

        messages.push({
          role: message.role as 'user' | 'assistant',
          content: textContent || '...',
        })
      }
    }
  }

  const openaiRequest: OpenAIRequest = {
    model: targetModel,
    messages,
    max_tokens: anthropic.max_tokens,
    stream: anthropic.stream || false,
  }

  // Optional parameters
  if (anthropic.temperature !== undefined) {
    openaiRequest.temperature = anthropic.temperature
  }
  if (anthropic.top_p !== undefined) {
    openaiRequest.top_p = anthropic.top_p
  }
  if (anthropic.stop_sequences?.length) {
    openaiRequest.stop = anthropic.stop_sequences
  }

  // Handle tools
  if (anthropic.tools?.length) {
    openaiRequest.tools = anthropic.tools.map((tool): OpenAITool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }))

    if (anthropic.tool_choice) {
      if (typeof anthropic.tool_choice === 'object' && anthropic.tool_choice.type === 'tool') {
        openaiRequest.tool_choice = {
          type: 'function',
          function: { name: anthropic.tool_choice.name },
        }
      } else if (typeof anthropic.tool_choice === 'string') {
        openaiRequest.tool_choice = anthropic.tool_choice
      }
    }
  }

  return openaiRequest
}

/**
 * Convert OpenAI response format to Anthropic format
 */
export function openAIToAnthropic(
  openai: OpenAIResponse,
  originalModel: string
): AnthropicResponse {
  const choice = openai.choices?.[0]

  if (!choice) {
    logger.warn('OpenAI response missing choices array')
    throw new Error('Invalid OpenAI response: missing choices')
  }

  const content: AnthropicContentBlock[] = []

  // Handle text content
  if (choice.message.content) {
    content.push({
      type: 'text',
      text: choice.message.content,
    })
  }

  // Handle tool calls
  if (choice.message.tool_calls) {
    for (const toolCall of choice.message.tool_calls) {
      try {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments || '{}'),
        })
      } catch (error) {
        logger.error(
          { toolCall, error },
          'Failed to parse tool call arguments'
        )
      }
    }
  }

  // Map finish reason
  let stopReason: AnthropicResponse['stop_reason'] = 'end_turn'
  if (choice.finish_reason === 'length') {
    stopReason = 'max_tokens'
  } else if (choice.finish_reason === 'tool_calls') {
    stopReason = 'tool_use'
  } else if (choice.finish_reason === 'stop') {
    stopReason = 'end_turn'
  }

  return {
    id: openai.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    type: 'message',
    role: 'assistant',
    model: originalModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens || 0,
      output_tokens: openai.usage?.completion_tokens || 0,
    },
  }
}

/**
 * Validate Anthropic request has required fields
 */
export function validateAnthropicRequest(request: any): request is AnthropicRequest {
  if (!request.model || typeof request.model !== 'string') {
    throw new Error('Invalid request: missing or invalid "model" field')
  }

  if (!request.max_tokens || typeof request.max_tokens !== 'number') {
    throw new Error('Invalid request: missing or invalid "max_tokens" field')
  }

  if (!Array.isArray(request.messages)) {
    throw new Error('Invalid request: "messages" must be an array')
  }

  if (request.messages.length === 0) {
    throw new Error('Invalid request: "messages" array cannot be empty')
  }

  return true
}
