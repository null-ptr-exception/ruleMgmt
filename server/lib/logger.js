import pino from 'pino'
import pinoHttp from 'pino-http'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
})

export const httpLogger = pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url?.includes('/assets/'),
  },
  customSuccessObject: (req, res, val) => {
    if (res.statusCode >= 400 && res._errorBody) {
      return { ...val, error: res._errorBody }
    }
    return val
  },
})
