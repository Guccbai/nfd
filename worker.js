const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const ADMIN_UID = ENV_ADMIN_UID // your user id, get it from https://t.me/username_to_id_bot

const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db';

const guestStartMsg = '你好，直接发送消息即可，我会尽快回复。'
const adminStartMsg = `使用方法：

- 当其他用户给bot发消息，会被转发到bot创建者
- 用户回复普通文字给转发的消息时，会回复到原消息发送者
- 用户回复 /block, /unblock, /checkblock 等命令会执行相关指令，不会回复到原消息发送者`
/**
 * Return url to telegram api, optionally with parameters added
 */
function apiUrl (methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}

function requestTelegram(methodName, body, params = null){
  return fetch(apiUrl(methodName, params), body)
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

function sendMessage(msg = {}){
  return requestTelegram('sendMessage', makeReqBody(msg))
}

function copyMessage(msg = {}){
  return requestTelegram('copyMessage', makeReqBody(msg))
}

function forwardMessage(msg){
  return requestTelegram('forwardMessage', makeReqBody(msg))
}

function answerCallbackQuery(msg){
  return requestTelegram('answerCallbackQuery', makeReqBody(msg))
}

function editMessageText(msg){
  return requestTelegram('editMessageText', makeReqBody(msg))
}

function deleteMessage(msg){
  return requestTelegram('deleteMessage', makeReqBody(msg))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

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
async function sendCaptcha(chatId, prefix = ''){
  const digits = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])
  const old = await nfd.get('captcha-' + chatId, { type: 'json' })
  const state = {
    seq: digits.slice(0, CAPTCHA_LEN),
    pad: shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    pos: 0,
    nonce: randInt(100000, 999999).toString(36),
    fails: old?.fails || 0,
    pending: old?.pending || [],
  }
  await nfd.put('captcha-' + chatId, JSON.stringify(state), { expirationTtl: CAPTCHA_TTL })

  return sendMessage({
    chat_id: chatId,
    text: captchaText(state, prefix),
    reply_markup: captchaKeyboard(state),
  })
}

/**
 * 未验证访客的消息：暂存并提示验证
 */
async function handleUnverified(message){
  const chatId = message.chat.id
  if(await nfd.get('captcha-lock-' + chatId)){
    return sendMessage({ chat_id: chatId, text: '验证失败次数过多，请稍后再试。' })
  }
  const state = await nfd.get('captcha-' + chatId, { type: 'json' })
  if(!state){
    await nfd.put('captcha-' + chatId, JSON.stringify({ fails: 0, pending: [message.message_id] }),
                  { expirationTtl: CAPTCHA_TTL })
    return sendCaptcha(chatId)
  }
  if(state.pending.length < CAPTCHA_MAX_PENDING){
    state.pending.push(message.message_id)
    await nfd.put('captcha-' + chatId, JSON.stringify(state), { expirationTtl: CAPTCHA_TTL })
  }
  return sendMessage({ chat_id: chatId, text: '请先按顺序点击上方验证码中的数字完成验证。' })
}

async function onCallbackQuery(query){
  const data = query.data || ''
  if(!data.startsWith('captcha:')){
    return answerCallbackQuery({ callback_query_id: query.id })
  }
  const chatId = query.message?.chat?.id
  const messageId = query.message?.message_id
  // 只接受私聊中本人点击
  if(!chatId || query.from.id !== chatId){
    return answerCallbackQuery({ callback_query_id: query.id, text: '无效操作' })
  }
  if(await isVerified(chatId)){
    await answerCallbackQuery({ callback_query_id: query.id, text: '你已通过验证' })
    return editMessageText({ chat_id: chatId, message_id: messageId, text: '✅ 已通过验证' })
  }
  if(await nfd.get('captcha-lock-' + chatId)){
    return answerCallbackQuery({ callback_query_id: query.id, text: '验证失败次数过多，请稍后再试', show_alert: true })
  }
  const state = await nfd.get('captcha-' + chatId, { type: 'json' })
  if(!state || !state.seq){
    await answerCallbackQuery({ callback_query_id: query.id, text: '验证码已过期，已重新生成' })
    await editMessageText({ chat_id: chatId, message_id: messageId, text: '验证码已过期' })
    return sendCaptcha(chatId)
  }

  const [, nonce, digit] = data.split(':')
  // 点的是旧验证码消息上的按钮
  if(nonce !== state.nonce){
    await answerCallbackQuery({ callback_query_id: query.id, text: '该验证码已失效，请使用最新的验证码' })
    return editMessageText({ chat_id: chatId, message_id: messageId, text: '验证码已失效' })
  }

  const choice = parseInt(digit, 10)
  if(choice === state.seq[state.pos]){
    state.pos += 1
    if(state.pos < state.seq.length){
      await nfd.put('captcha-' + chatId, JSON.stringify(state), { expirationTtl: CAPTCHA_TTL })
      await answerCallbackQuery({ callback_query_id: query.id })
      return editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: captchaText(state),
        reply_markup: captchaKeyboard(state),
      })
    }

    await nfd.put('verified-' + chatId, true)
    await nfd.delete('captcha-' + chatId)
    await answerCallbackQuery({ callback_query_id: query.id, text: '验证通过' })
    await editMessageText({ chat_id: chatId, message_id: messageId, text: '✅ 验证通过，现在可以直接发送消息了。' })
    // 转发验证前暂存的消息
    for(const mid of state.pending){
      await forwardGuestMessage(chatId, mid)
    }
    // 提示停留几秒后自动删除
    await sleep(CAPTCHA_PASS_MSG_TTL * 1000)
    return deleteMessage({ chat_id: chatId, message_id: messageId })
  }

  const fails = (state.fails || 0) + 1
  if(fails >= CAPTCHA_MAX_FAILS){
    await nfd.delete('captcha-' + chatId)
    await nfd.put('captcha-lock-' + chatId, true, { expirationTtl: CAPTCHA_LOCK_TTL })
    await answerCallbackQuery({ callback_query_id: query.id, text: '答错次数过多', show_alert: true })
    return editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: `❌ 答错次数过多，请 ${CAPTCHA_LOCK_TTL / 3600} 小时后再试。`,
    })
  }
  state.fails = fails
  await nfd.put('captcha-' + chatId, JSON.stringify(state), { expirationTtl: CAPTCHA_TTL })
  await answerCallbackQuery({ callback_query_id: query.id, text: '顺序错误，请重试' })
  await editMessageText({ chat_id: chatId, message_id: messageId, text: '❌ 顺序错误' })
  return sendCaptcha(chatId, `顺序错误（剩余 ${CAPTCHA_MAX_FAILS - fails} 次机会）。\n`)
}

/**
 * Wait for requests to the worker
 */
addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
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
async function handleWebhook (event) {
  // Check secret
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }

  // Read request body synchronously
  const update = await event.request.json()
  // Deal with response asynchronously
  event.waitUntil(onUpdate(update))

  return new Response('Ok')
}

/**
 * Handle incoming Update
 * https://core.telegram.org/bots/api#update
 */
async function onUpdate (update) {
  if ('message' in update) {
    await onMessage(update.message)
  } else if ('callback_query' in update) {
    await onCallbackQuery(update.callback_query)
  }
}

/**
 * Handle incoming Message
 * https://core.telegram.org/bots/api#message
 */
async function onMessage (message) {
  if(message.text === '/start'){
    const isAdmin = message.chat.id.toString() === ADMIN_UID
    await sendMessage({
      chat_id:message.chat.id,
      text:isAdmin ? adminStartMsg : guestStartMsg,
    })
    if(!isAdmin && !(await isVerified(message.chat.id))
       && !(await nfd.get('captcha-lock-' + message.chat.id))){
      return sendCaptcha(message.chat.id)
    }
    return
  }
  if(message.chat.id.toString() === ADMIN_UID){
    if(!message?.reply_to_message?.chat){
      return sendMessage({
        chat_id:ADMIN_UID,
        text:'使用方法，回复转发的消息，并发送回复消息，或者`/block`、`/unblock`、`/checkblock`等指令'
      })
    }
    if(/^\/block$/.exec(message.text)){
      return handleBlock(message)
    }
    if(/^\/unblock$/.exec(message.text)){
      return handleUnBlock(message)
    }
    if(/^\/checkblock$/.exec(message.text)){
      return checkBlock(message)
    }
    let guestChantId = await nfd.get('msg-map-' + message?.reply_to_message.message_id,
                                      { type: "json" })
    return copyMessage({
      chat_id: guestChantId,
      from_chat_id:message.chat.id,
      message_id:message.message_id,
    })
  }
  return handleGuestMessage(message)
}

async function handleGuestMessage(message){
  let chatId = message.chat.id;
  let isblocked = await nfd.get('isblocked-' + chatId, { type: "json" })
  
  if(isblocked){
    return sendMessage({
      chat_id: chatId,
      text:'Your are blocked'
    })
  }

  if(!(await isVerified(chatId))){
    return handleUnverified(message)
  }

  await forwardGuestMessage(chatId, message.message_id)
  return handleNotify(message)
}

async function forwardGuestMessage(chatId, messageId){
  let forwardReq = await forwardMessage({
    chat_id:ADMIN_UID,
    from_chat_id:chatId,
    message_id:messageId
  })
  console.log(JSON.stringify(forwardReq))
  if(forwardReq.ok){
    await nfd.put('msg-map-' + forwardReq.result.message_id, chatId)
  }
  return forwardReq
}

async function handleNotify(message){
  // 如果是诈骗人员，则直接提醒
  let chatId = message.chat.id;
  if(await isFraud(chatId)){
    return sendMessage({
      chat_id: ADMIN_UID,
      text:`检测到骗子，UID${chatId}`
    })
  }
}

async function handleBlock(message){
  let guestChantId = await nfd.get('msg-map-' + message.reply_to_message.message_id,
                                      { type: "json" })
  if(guestChantId === ADMIN_UID){
    return sendMessage({
      chat_id: ADMIN_UID,
      text:'不能屏蔽自己'
    })
  }
  await nfd.put('isblocked-' + guestChantId, true)

  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChantId}屏蔽成功`,
  })
}

async function handleUnBlock(message){
  let guestChantId = await nfd.get('msg-map-' + message.reply_to_message.message_id,
  { type: "json" })

  await nfd.put('isblocked-' + guestChantId, false)

  return sendMessage({
    chat_id: ADMIN_UID,
    text:`UID:${guestChantId}解除屏蔽成功`,
  })
}

async function checkBlock(message){
  let guestChantId = await nfd.get('msg-map-' + message.reply_to_message.message_id,
  { type: "json" })
  let blocked = await nfd.get('isblocked-' + guestChantId, { type: "json" })

  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChantId}` + (blocked ? '被屏蔽' : '没有被屏蔽')
  })
}

/**
 * Send plain text message
 * https://core.telegram.org/bots/api#sendmessage
 */
async function sendPlainText (chatId, text) {
  return sendMessage({
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
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`
  const r = await (await fetch(apiUrl('setWebhook', { url: webhookUrl, secret_token: secret }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

/**
 * Remove webhook
 * https://core.telegram.org/bots/api#setwebhook
 */
async function unRegisterWebhook (event) {
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
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