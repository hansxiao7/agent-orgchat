// Slack adapter. Uses Socket Mode, so the bridge needs no public URL.
//
// App setup (api.slack.com/apps > Create app):
//   - Socket Mode: on; create an app-level token with connections:write (xapp-...)
//   - App Home: enable the Messages tab and "allow users to send messages"
//   - Event subscriptions: bot event message.im
//   - Bot token scopes: chat:write, im:history, im:write, users:read, users:read.email
//   - Install to the workspace; use the bot token (xoxb-...)

import bolt from '@slack/bolt';

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function createSlackAdapter({ botToken, appToken, log = () => {} }) {
  const app = new bolt.App({ token: botToken, appToken, socketMode: true, logLevel: bolt.LogLevel.WARN });
  const dmChannels = new Map();

  async function dmChannel(userId) {
    if (!dmChannels.has(userId)) {
      const res = await app.client.conversations.open({ users: userId });
      dmChannels.set(userId, res.channel.id);
    }
    return dmChannels.get(userId);
  }

  return {
    name: 'slack',

    async start(onInbound) {
      app.message(async ({ message }) => {
        if (message.channel_type !== 'im' || message.subtype || message.bot_id) return;
        dmChannels.set(message.user, message.channel);
        const inThread = message.thread_ts && message.thread_ts !== message.ts;
        onInbound({
          userId: message.user,
          text: unescape(message.text || ''),
          ref: `${message.channel}:${message.ts}`,
          replyTo: inThread ? `${message.channel}:${message.thread_ts}` : null,
        });
      });
      await app.start();
      log({ event: 'slack_connected' });
    },

    async lookupUser(userId) {
      const res = await app.client.users.info({ user: userId });
      const u = res.user || {};
      if (u.is_bot) return { email: '', name: u.name };
      return { email: String(u.profile?.email || '').toLowerCase(), name: u.real_name || u.profile?.display_name || u.name || userId };
    },

    async sendToUser(userId, text) {
      const channel = await dmChannel(userId);
      const res = await app.client.chat.postMessage({ channel, text: escape(text), unfurl_links: false, unfurl_media: false });
      return `${channel}:${res.ts}`;
    },

    async reply(ref, text) {
      const [channel, ts] = ref.split(':');
      await app.client.chat.postMessage({ channel, text: escape(text), thread_ts: ts, unfurl_links: false });
      // Replies inside a thread are threaded under the root, so refer to the root.
      return `${channel}:${ts}`;
    },
  };
}
