// 单个 bot：设置 ENV_BOT_TOKEN；多个 bot：设置 ENV_BOTS（多个 token 用逗号或换行分隔）
// 两者可同时设置，会合并去重。所有 bot 的消息都转发给同一个 ADMIN_UID
const LEGACY_TOKEN = typeof ENV_BOT_TOKEN !== 'undefined' ? ENV_BOT_TOKEN.trim() : '' // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const ADMIN_UID = ENV_ADMIN_UID // your user id, get it from https://t.me/username_to_id_bot

/**
 * bot 上下文：{ id, token, prefix, legacy }
 * - id：token 冒号前的数字，即 bot 的 user id，用于 webhook 路径 /endpoint/<id>
 * - prefix：KV 中按 bot 区分的 key 前缀（消息映射、验证码状态）
 * - legacy：是否为 ENV_BOT_TOKEN 配置的 bot，兼容旧版未加前缀的数据
 */
const BOTS = (() => {
  const extra = typeof ENV_BOTS !== 'undefined' ? ENV_BOTS.split(/[\s,]+/) : []
  const tokens = [...new Set([LEGACY_TOKEN, ...extra].map(t => t.trim()).filter(Boolean))]
  return tokens.map(token => {
    const id = token.split(':')[0]
    return { id, token, prefix: `bot${id}-`, legacy: token === LEGACY_TOKEN }
  })
})()

function findBot(pathname){
  if(pathname === WEBHOOK){
    // 旧版 webhook 地址，对应 ENV_BOT_TOKEN 的 bot
    return BOTS.find(b => b.legacy) || BOTS[0]
  }
  if(pathname.startsWith(WEBHOOK + '/')){
    const id = pathname.slice(WEBHOOK.length + 1)
    return BOTS.find(b => b.id === id)
  }
}

const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db';

const guestStartMsg = '你好，直接发送消息即可，我会尽快回复。'
const adminStartMsg = `使用方法：

- 当其他用户给bot发消息，会被转发到bot创建者
- 用户回复普通文字给转发的消息时，会回复到原消息发送者
- 用户回复 /block, /unblock, /checkblock 等命令会执行相关指令，不会回复到原消息发送者`
/**
 * Return url to telegram api, optionally with parameters added
 */
function apiUrl (bot, methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${bot.token}/${methodName}${query}`
}

function requestTelegram(bot, methodName, body, params = null){
  return fetch(apiUrl(bot, methodName, params), body)
    .then(r => r.json())
}

function makeReqBody(body){
  return {
    method:'POST',
    headers:{
      'content-type':'application/json'
    },
    body:JSON.stringify(body)
  }
}

function sendMessage(bot, msg = {}){
  return requestTelegram(bot, 'sendMessage', makeReqBody(msg))
}

function copyMessage(bot, msg = {}){
  return requestTelegram(bot, 'copyMessage', makeReqBody(msg))
}

function forwardMessage(bot, msg){
  return requestTelegram(bot, 'forwardMessage', makeReqBody(msg))
}

function answerCallbackQuery(bot, msg){
  return requestTelegram(bot, 'answerCallbackQuery', makeReqBody(msg))
}

function editMessageText(bot, msg){
  return requestTelegram(bot, 'editMessageText', makeReqBody(msg))
}

function deleteMessage(bot, msg){
  return requestTelegram(bot, 'deleteMessage', makeReqBody(msg))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ===== KV key =====
// 按 bot 区分：消息映射（各 bot 私聊中的 message_id 会重复）、验证码状态
// 所有 bot 共用：verified-（通过一次验证即可）、captcha-lock-、isblocked-（屏蔽对所有 bot 生效）
const captchaKey = (bot, chatId) => bot.prefix + 'captcha-' + chatId

async function getGuestChatId(bot, adminMessageId){
  const id = await nfd.get(bot.prefix + 'msg-map-' + adminMessageId, { type: 'json' })
  if(id !== null || !bot.legacy) return id
  return nfd.get('msg-map-' + adminMessageId, { type: 'json' })
}

// ===== 验证码：按顺序点击数字 =====
const CAPTCHA_TTL = 300          // 验证码有效期（秒），KV 最小 60
const CAPTCHA_LEN = 4            // 需要依次点击的数字个数（从 1-9 中不重复抽取）
const CAPTCHA_MAX_FAILS = 3      // 连续答错次数上限
const CAPTCHA_LOCK_TTL = 6 * 3600 // 答错过多后的锁定时长（秒）
const CAPTCHA_MAX_PENDING = 5    // 验证通过前最多暂存的消息数，通过后一并转发
const CAPTCHA_PASS_MSG_TTL = 5   // “验证通过”提示保留秒数，之后自动删除（Worker 后台最多约 30 秒）

function randInt(min, max){
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return min + (buf[0] % (max - min + 1))
}

function shuffle(arr){
  for(let i = arr.length - 1; i > 0; i--){
    const j = randInt(0, i)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

async function isVerified(chatId){
  return !!(await nfd.get('verified-' + chatId, { type: 'json' }))
}

function captchaText(state, prefix = ''){
  const progress = '●'.repeat(state.pos) + '○'.repeat(state.seq.length - state.pos)
  return `${prefix}为防止广告骚扰，首次发消息前请完成验证（${CAPTCHA_TTL / 60} 分钟内有效）。\n\n`
    + `请按顺序依次点击：${state.seq.join('  ')}\n\n进度：${progress}`
}

function captchaKeyboard(state){
  const rows = []
  for(let i = 0; i < state.pad.length; i += 3){
    rows.push(state.pad.slice(i, i + 3).map(v => ({
      text: String(v),
      callback_data: `captcha:${state.nonce}:${v}`,
    })))
  }
  return { inline_keyboard: rows }
}

/**
 * 给访客发验证码：从 1-9 中抽 CAPTCHA_LEN 个不重复数字，要求按顺序在打乱的九宫格中点击
 */
async function sendCaptcha(bot, chatId, prefix = ''){
  const digits = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])
  const old = await nfd.get(captchaKey(bot, chatId), { type: 'json' })
  const state = {
    seq: digits.slice(0, CAPTCHA_LEN),
    pad: shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    pos: 0,
    nonce: randInt(100000, 999999).toString(36),
    fails: old?.fails || 0,
    pending: old?.pending || [],
  }
  await nfd.put(captchaKey(bot, chatId), JSON.stringify(state), { expirationTtl: CAPTCHA_TTL })

  return sendMessage(bot, {
    chat_id: chatId,
    text: captchaText(state, prefix),
    reply_markup: captchaKeyboard(state),
  })
}

/**
 * 未验证访客的消息：暂存并提示验证
 */
async function handleUnverified(bot, message){
  const chatId = message.chat.id
  if(await nfd.get('captcha-lock-' + chatId)){
    return sendMessage(bot, { chat_id: chatId, text: '验证失败次数过多，请稍后再试。' })
  }
  const state = await nfd.get(captchaKey(bot, chatId), { type: 'json' })
  if(!state){
    await nfd.put(captchaKey(bot, chatId), JSON.stringify({ fails: 0, pending: [message.message_id] }),
                  { expirationTtl: CAPTCHA_TTL })
    return sendCaptcha(bot, chatId)
  }
  if(state.pending.length < CAPTCHA_MAX_PENDING){
    state.pending.push(message.message_id)
    await nfd.put(captchaKey(bot, chatId), JSON.stringify(state), { expirationTtl: CAPTCHA_TTL })
  }
  return sendMessage(bot, { chat_id: chatId, text: '请先按顺序点击上方验证码中的数字完成验证。' })
}

async function onCallbackQuery(bot, query){
  const data = query.data || ''
  if(!data.startsWith('captcha:')){
    return answerCallbackQuery(bot, { callback_query_id: query.id })
  }
  const chatId = query.message?.chat?.id
  const messageId = query.message?.message_id
  // 只接受私聊中本人点击
  if(!chatId || query.from.id !== chatId){
    return answerCallbackQuery(bot, { callback_query_id: query.id, text: '无效操作' })
  }
  if(await isVerified(chatId)){
    await answerCallbackQuery(bot, { callback_query_id: query.id, text: '你已通过验证' })
    return editMessageText(bot, { chat_id: chatId, message_id: messageId, text: '✅ 已通过验证' })
  }
  if(await nfd.get('captcha-lock-' + chatId)){
    return answerCallbackQuery(bot, { callback_query_id: query.id, text: '验证失败次数过多，请稍后再试', show_alert: true })
  }
  const state = await nfd.get(captchaKey(bot, chatId), { type: 'json' })
  if(!state || !state.seq){
    await answerCallbackQuery(bot, { callback_query_id: query.id, text: '验证码已过期，已重新生成' })
    await editMessageText(bot, { chat_id: chatId, message_id: messageId, text: '验证码已过期' })
    return sendCaptcha(bot, chatId)
  }

  const [, nonce, digit] = data.split(':')
  // 点的是旧验证码消息上的按钮
  if(nonce !== state.nonce){
    await answerCallbackQuery(bot, { callback_query_id: query.id, text: '该验证码已失效，请使用最新的验证码' })
    return editMessageText(bot, { chat_id: chatId, message_id: messageId, text: '验证码已失效' })
  }

  const choice = parseInt(digit, 10)
  if(choice === state.seq[state.pos]){
    state.pos += 1
    if(state.pos < state.seq.length){
      await nfd.put(captchaKey(bot, chatId), JSON.stringify(state), { expirationTtl: CAPTCHA_TTL })
      await answerCallbackQuery(bot, { callback_query_id: query.id })
      return editMessageText(bot, {
        chat_id: chatId,
        message_id: messageId,
        text: captchaText(state),
        reply_markup: captchaKeyboard(state),
      })
    }

    await nfd.put('verified-' + chatId, true)
    await nfd.delete(captchaKey(bot, chatId))
    await answerCallbackQuery(bot, { callback_query_id: query.id, text: '验证通过' })
    await editMessageText(bot, { chat_id: chatId, message_id: messageId, text: '✅ 验证通过，现在可以直接发送消息了。' })
    // 转发验证前暂存的消息
    for(const mid of state.pending){
      await forwardGuestMessage(bot, chatId, mid)
    }
    // 提示停留几秒后自动删除
    await sleep(CAPTCHA_PASS_MSG_TTL * 1000)
    return deleteMessage(bot, { chat_id: chatId, message_id: messageId })
  }

  const fails = (state.fails || 0) + 1
  if(fails >= CAPTCHA_MAX_FAILS){
    await nfd.delete(captchaKey(bot, chatId))
    await nfd.put('captcha-lock-' + chatId, true, { expirationTtl: CAPTCHA_LOCK_TTL })
    await answerCallbackQuery(bot, { callback_query_id: query.id, text: '答错次数过多', show_alert: true })
    return editMessageText(bot, {
      chat_id: chatId,
      message_id: messageId,
      text: `❌ 答错次数过多，请 ${CAPTCHA_LOCK_TTL / 3600} 小时后再试。`,
    })
  }
  state.fails = fails
  await nfd.put(captchaKey(bot, chatId), JSON.stringify(state), { expirationTtl: CAPTCHA_TTL })
  await answerCallbackQuery(bot, { callback_query_id: query.id, text: '顺序错误，请重试' })
  await editMessageText(bot, { chat_id: chatId, message_id: messageId, text: '❌ 顺序错误' })
  return sendCaptcha(bot, chatId, `顺序错误（剩余 ${CAPTCHA_MAX_FAILS - fails} 次机会）。\n`)
}

/**
 * Wait for requests to the worker
 */
addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  const bot = findBot(url.pathname)
  if (bot) {
    event.respondWith(handleWebhook(event, bot))
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(unRegisterWebhook(event))
  } else {
    event.respondWith(new Response('No handler for this request'))
  }
})

/**
 * Handle requests to WEBHOOK
 * https://core.telegram.org/bots/api#update
 */
async function handleWebhook (event, bot) {
  // Check secret
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }

  // Read request body synchronously
  const update = await event.request.json()
  // Deal with response asynchronously
  event.waitUntil(onUpdate(bot, update))

  return new Response('Ok')
}

/**
 * Handle incoming Update
 * https://core.telegram.org/bots/api#update
 */
async function onUpdate (bot, update) {
  if ('message' in update) {
    await onMessage(bot, update.message)
  } else if ('callback_query' in update) {
    await onCallbackQuery(bot, update.callback_query)
  }
}

/**
 * Handle incoming Message
 * https://core.telegram.org/bots/api#message
 */
async function onMessage (bot, message) {
  if(message.text === '/start'){
    const isAdmin = message.chat.id.toString() === ADMIN_UID
    await sendMessage(bot, {
      chat_id:message.chat.id,
      text:isAdmin ? adminStartMsg : guestStartMsg,
    })
    if(!isAdmin && !(await isVerified(message.chat.id))
       && !(await nfd.get('captcha-lock-' + message.chat.id))){
      return sendCaptcha(bot, message.chat.id)
    }
    return
  }
  if(message.chat.id.toString() === ADMIN_UID){
    if(!message?.reply_to_message?.chat){
      return sendMessage(bot, {
        chat_id:ADMIN_UID,
        text:'使用方法，回复转发的消息，并发送回复消息，或者`/block`、`/unblock`、`/checkblock`等指令'
      })
    }
    if(/^\/block$/.exec(message.text)){
      return handleBlock(bot, message)
    }
    if(/^\/unblock$/.exec(message.text)){
      return handleUnBlock(bot, message)
    }
    if(/^\/checkblock$/.exec(message.text)){
      return checkBlock(bot, message)
    }
    let guestChantId = await getGuestChatId(bot, message?.reply_to_message.message_id)
    if(!guestChantId){
      return sendMessage(bot, { chat_id: ADMIN_UID, text: '找不到这条消息对应的访客，请回复由本 bot 转发的消息' })
    }
    return copyMessage(bot, {
      chat_id: guestChantId,
      from_chat_id:message.chat.id,
      message_id:message.message_id,
    })
  }
  return handleGuestMessage(bot, message)
}

async function handleGuestMessage(bot, message){
  let chatId = message.chat.id;
  let isblocked = await nfd.get('isblocked-' + chatId, { type: "json" })
  
  if(isblocked){
    return sendMessage(bot, {
      chat_id: chatId,
      text:'Your are blocked'
    })
  }

  if(!(await isVerified(chatId))){
    return handleUnverified(bot, message)
  }

  await forwardGuestMessage(bot, chatId, message.message_id)
  return handleNotify(bot, message)
}

async function forwardGuestMessage(bot, chatId, messageId){
  let forwardReq = await forwardMessage(bot, {
    chat_id:ADMIN_UID,
    from_chat_id:chatId,
    message_id:messageId
  })
  console.log(JSON.stringify(forwardReq))
  if(forwardReq.ok){
    await nfd.put(bot.prefix + 'msg-map-' + forwardReq.result.message_id, chatId)
  }
  return forwardReq
}

async function handleNotify(bot, message){
  // 如果是诈骗人员，则直接提醒
  let chatId = message.chat.id;
  if(await isFraud(chatId)){
    return sendMessage(bot, {
      chat_id: ADMIN_UID,
      text:`检测到骗子，UID${chatId}`
    })
  }
}

async function handleBlock(bot, message){
  let guestChantId = await getGuestChatId(bot, message.reply_to_message.message_id)
  if(guestChantId === ADMIN_UID){
    return sendMessage(bot, {
      chat_id: ADMIN_UID,
      text:'不能屏蔽自己'
    })
  }
  await nfd.put('isblocked-' + guestChantId, true)

  return sendMessage(bot, {
    chat_id: ADMIN_UID,
    text: `UID:${guestChantId}屏蔽成功`,
  })
}

async function handleUnBlock(bot, message){
  let guestChantId = await getGuestChatId(bot, message.reply_to_message.message_id)

  await nfd.put('isblocked-' + guestChantId, false)

  return sendMessage(bot, {
    chat_id: ADMIN_UID,
    text:`UID:${guestChantId}解除屏蔽成功`,
  })
}

async function checkBlock(bot, message){
  let guestChantId = await getGuestChatId(bot, message.reply_to_message.message_id)
  let blocked = await nfd.get('isblocked-' + guestChantId, { type: "json" })

  return sendMessage(bot, {
    chat_id: ADMIN_UID,
    text: `UID:${guestChantId}` + (blocked ? '被屏蔽' : '没有被屏蔽')
  })
}

/**
 * Send plain text message
 * https://core.telegram.org/bots/api#sendmessage
 */
async function sendPlainText (bot, chatId, text) {
  return sendMessage(bot, {
    chat_id: chatId,
    text
  })
}

/**
 * Set webhook to this worker's url
 * https://core.telegram.org/bots/api#setwebhook
 */
async function registerWebhook (event, requestUrl, suffix, secret) {
  // https://core.telegram.org/bots/api#setwebhook
  const results = await Promise.all(BOTS.map(async bot => {
    const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}/${bot.id}`
    const r = await (await fetch(apiUrl(bot, 'setWebhook', { url: webhookUrl, secret_token: secret }))).json()
    return `${bot.id}: ` + ('ok' in r && r.ok ? 'Ok' : JSON.stringify(r))
  }))
  return new Response(results.join('\n') || 'No bot configured')
}

/**
 * Remove webhook
 * https://core.telegram.org/bots/api#setwebhook
 */
async function unRegisterWebhook (event) {
  const results = await Promise.all(BOTS.map(async bot => {
    const r = await (await fetch(apiUrl(bot, 'setWebhook', { url: '' }))).json()
    return `${bot.id}: ` + ('ok' in r && r.ok ? 'Ok' : JSON.stringify(r))
  }))
  return new Response(results.join('\n') || 'No bot configured')
}

async function isFraud(id){
  id = id.toString()
  let db = await fetch(fraudDb).then(r => r.text())
  let arr = db.split('\n').filter(v => v)
  console.log(JSON.stringify(arr))
  let flag = arr.filter(v => v === id).length !== 0
  console.log(flag)
  return flag
}