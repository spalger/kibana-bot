import QueryString from 'querystring'
import Iron from '@hapi/iron'
import { Client } from '@elastic/elasticsearch'

import Axios from 'axios'

import { scrollSearch } from './es'
import * as AsyncIter from './async_iterators'
import { Logger, getRequestLogger } from './log'
import { makeAutoCache } from './auto_cache'
import { Config } from './config'
import { isAxiosErrorResp, createAxiosErrorResp } from './axios_errors'
import { EsHit, EsClient } from './es'
import { ServerError } from './error_response'
import { ReqContext } from './req_context'

/**
 * required escaping per slack api docs
 * https://api.slack.com/docs/message-formatting#3_characters_you_must_encode_as_html_entities
 */
const FORBIDDEN_CHAR_RE = /&|<|>/g
function replaceForbiddenChar(match: string) {
  switch (match) {
    case '&':
      return '&amp;'
    case '<':
      return '&lt;'
    case '>':
      return '&gt;'
    default:
      throw new Error(`how did ${FORBIDDEN_CHAR_RE.source} match ${match}?`)
  }
}

function slackEscape(msg: string) {
  return msg.replace(FORBIDDEN_CHAR_RE, replaceForbiddenChar)
}

function has<T extends string>(
  x: any,
  key: T,
): x is { [k in typeof key]: any } {
  return (
    x && typeof x === 'object' && Object.prototype.hasOwnProperty.call(x, key)
  )
}

function isObj(x: any): x is object {
  return x && typeof x === 'object'
}

function isString(x: any): x is string {
  return x && typeof x === 'string'
}

type CredSource = {
  created_at: string
  payload: string
}

export class SlackApi {
  private readonly credsIndex: string
  private readonly basicAuth: string
  private readonly encrypt: (data: unknown) => Promise<string>
  private readonly decrypt: <T = unknown>(data: string) => Promise<T>

  constructor(
    private readonly log: Logger,
    private readonly es: Client,
    config: {
      credsIndex: string
      clientId: string
      clientSecret: string
      credsPassword: string
    },
  ) {
    this.credsIndex = config.credsIndex

    const parsedPassword = this.parsePassword(config.credsPassword)

    this.basicAuth =
      'basic ' +
      Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString(
        'base64',
      )

    this.encrypt = async (data: unknown) => {
      return await Iron.seal(data, parsedPassword, Iron.defaults)
    }

    this.decrypt = async (sealed: string) => {
      return await Iron.unseal(
        sealed,
        {
          [parsedPassword.id]: parsedPassword.secret,
        },
        Iron.defaults,
      )
    }
  }

  public async finishOauth(code: string, redirectUri?: string) {
    const formData = QueryString.stringify({
      code,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      single_channel: false,
    })

    this.log.info({
      type: 'slackOauthComplete',
      message: 'finishing slack oauth',
      extra: {
        code,
        redirectUri,
        formData,
      },
    })

    let response
    try {
      response = await Axios.request<
        | {
            ok: false
            error: string
          }
        | {
            ok: true
            access_token: string
            scope: string
            user_id: string
            team_id: string
            enterprise_id?: string
            team_name: string
            incoming_webhook: {
              channel: string
              channel_id: string
              configuration_url: string
              url: string
            }
          }
      >({
        url: 'https://slack.com/api/oauth.access',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: this.basicAuth,
        },
        data: formData,
      })

      if (response.data.ok !== true) {
        throw createAxiosErrorResp(response, response.data.error)
      }
    } catch (error) {
      if (isAxiosErrorResp(error)) {
        this.log.error({
          type: 'slackOauthComplete-FailureResponse',
          message: 'failed to finish slack oauth',
          extra: {
            config: error.config,
            status: error.response.status,
            headers: error.response.headers,
            resp: error.response.data,
          },
        })
      } else {
        this.log.error({
          type: 'slackOauthComplete-RequestFailure',
          message: 'failed to send request to slack',
          extra: {
            error: error.stack || error.message || error,
          },
        })
      }

      throw error
    }

    await this.es.index({
      index: this.credsIndex,
      id: response.data.team_name,
      body: {
        created_at: new Date().toJSON(),
        payload: await this.encryptCredsFromSlackAuth(response.data),
      } as CredSource,
    })

    return response.data
  }

  private async sendToWebhook(escapedText: string, webhookUrl: string) {
    try {
      await Axios.request({
        url: webhookUrl,
        method: 'POST',
        data: {
          text: escapedText,
        },
      })
    } catch (error) {
      if (isAxiosErrorResp(error)) {
        this.log.error({
          type: 'send to slack webhook - failure response',
          extra: {
            msg: escapedText,
            status: error.response.status,
            headers: error.response.headers,
            resp: error.response.data,
          },
        })
        return
      }

      this.log.error({
        type: 'send to slack webhook - request failure',
        extra: {
          msg: escapedText,
          error: error.stack || error.message || error,
        },
      })
    }
  }

  private async encryptCredsFromSlackAuth(authResp: unknown) {
    let webhookUrl: string | undefined
    if (
      has(authResp, 'incoming_webhook') &&
      isObj(authResp.incoming_webhook) &&
      has(authResp.incoming_webhook, 'url') &&
      isString(authResp.incoming_webhook.url)
    ) {
      webhookUrl = authResp.incoming_webhook.url
    }

    let accessToken: string | undefined
    if (has(authResp, 'access_token') && isString(authResp.access_token)) {
      accessToken = authResp.access_token
    }

    if (!webhookUrl || !accessToken) {
      this.log.error({
        type: 'Unable to parse creds from slack auth',
        extra: {
          encrypted_slack_creds: this.encrypt(authResp),
        },
      })
      throw new ServerError('unable to parse message from slack')
    }

    return await this.encrypt({
      webhookUrl,
      accessToken,
    })
  }

  private async decryptSlackCreds(encryptedPayload: string) {
    const decrypted = await this.decrypt(encryptedPayload)

    const webhookUrl =
      has(decrypted, 'webhookUrl') && isString(decrypted.webhookUrl)
        ? decrypted.webhookUrl
        : undefined

    const accessToken =
      has(decrypted, 'accessToken') && isString(decrypted.accessToken)
        ? decrypted.accessToken
        : undefined

    if (!webhookUrl || !accessToken) {
      this.log.error({
        type: 'Unable to parse stored creds from slack creds index',
        extra: {
          encrypted_slack_creds: encryptedPayload,
        },
      })
      throw new ServerError('unable to parse stored creds')
    }

    return {
      webhookUrl,
      accessToken,
    }
  }

  public async getAllCreds() {
    return await AsyncIter.collect(this.makeAllCredsIter())
  }

  private makeAllCredsIter() {
    return scrollSearch<EsHit<CredSource>>(this.es, {
      index: this.credsIndex,
    })
  }

  public async broadcast(msg: string) {
    this.log.info({
      type: 'Broadcasting msg to all slack webhooks',
      extra: {
        msg,
      },
    })

    const failures = await AsyncIter.attempt(
      this.makeAllCredsIter(),
      async ({ _source: { payload } }) => {
        const creds = await this.decryptSlackCreds(payload)
        await this.sendToWebhook(slackEscape(msg), creds.webhookUrl)
      },
      {
        concurrency: 10,
      },
    )

    for (const failure of failures) {
      this.log.error({
        type: 'slackBroadcastFailure',
        extra: {
          stack: failure.reason.stack,
        },
      })
    }
  }

  private parsePassword(
    json: string,
  ): {
    readonly id: string
    readonly secret: string
  } {
    try {
      return JSON.parse(json)
    } catch (error) {
      throw new ServerError('unable to parse slaskCredsPassword JSON')
    }
  }
}

export const makeSlackApi = (log: Logger, es: EsClient, config: Config) => {
  return new SlackApi(log, es, {
    credsIndex: config.get('slackCredsIndex'),
    clientId: config.get('slackClientId'),
    clientSecret: config.get('slackClientSecret'),
    credsPassword: config.get('slackCredsPassword'),
  })
}

const slackApiCache = makeAutoCache((ctx: ReqContext) => {
  const log = getRequestLogger(ctx)
  return makeSlackApi(log, ctx.server.es, ctx.server.config)
})

export const getSlackApi = slackApiCache.get
