// Lark / Feishu adapter. Uses the official SDK's long-connection (WebSocket)
// event mode, so the bridge needs no public URL.
//
// App setup (open.feishu.cn or open.larksuite.com > your app):
//   - Enable the Bot capability
//   - Events: subscribe to im.message.receive_v1, delivery mode "long connection"
//   - Permissions: im:message (send), im:message.p2p_msg:readonly (receive DMs),
//     contact:user.base:readonly + contact:user.email:readonly (map people to emails)
//   - Publish a version and make it available to your organization

import * as lark from '@larksuiteoapi/node-sdk';

export function createLarkAdapter({ appId, appSecret, domain = 'feishu', log = () => {} }) {
  const base = { appId, appSecret, domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu };
  const client = new lark.Client(base);
  const textContent = (text) => JSON.stringify({ text });

  const adapter = {
    name: 'lark',

    async start(onInbound) {
      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          const { message, sender } = data;
          if (message?.chat_type !== 'p2p' || sender?.sender_type !== 'user') return;
          const ref = message.message_id;
          if (message.message_type !== 'text') {
            await adapter.reply(ref, 'Only text messages are supported.').catch(() => {});
            return;
          }
          let text = '';
          try {
            text = JSON.parse(message.content).text || '';
          } catch {
            /* ignore malformed content */
          }
          // Don't block the event ack on relay round-trips.
          setImmediate(() => onInbound({
            userId: sender.sender_id.open_id,
            text,
            ref,
            replyTo: message.parent_id || message.root_id || null,
          }));
        },
      });
      const ws = new lark.WSClient({ ...base, loggerLevel: lark.LoggerLevel.warn });
      await ws.start({ eventDispatcher: dispatcher });
      log({ event: 'lark_connected' });
    },

    async lookupUser(openId) {
      const res = await client.contact.user.get({ path: { user_id: openId }, params: { user_id_type: 'open_id' } });
      const u = res?.data?.user || {};
      return { email: String(u.enterprise_email || u.email || '').toLowerCase(), name: u.name || u.en_name || openId };
    },

    async sendToUser(openId, text) {
      const res = await client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: 'text', content: textContent(text) },
      });
      return res?.data?.message_id;
    },

    async reply(messageId, text) {
      const res = await client.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: textContent(text) },
      });
      return res?.data?.message_id;
    },
  };
  return adapter;
}
