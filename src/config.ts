import { config as dotenvConfig } from 'dotenv'
import { Config } from './types'

dotenvConfig()

const getEnv = (key: string, fallback = ''): string => process.env[key] || fallback

export const config: Config = {
  litellmBaseUrl: getEnv('LITELLM_BASE_URL', 'http://localhost:4000'),
  model: getEnv('MODEL', 'gpt-4o'),
  upstreamApiKey: getEnv('UPSTREAM_API_KEY'),
  port: parseInt(getEnv('PORT', '8082')),
  logLevel: getEnv('LOG_LEVEL', 'info'),
  nodeEnv: getEnv('NODE_ENV', 'development'),
}
